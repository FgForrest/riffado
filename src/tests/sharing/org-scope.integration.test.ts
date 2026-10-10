/**
 * The Organization scope, against a real PostgreSQL.
 *
 * Everything that decides who may see or change a shared recording is SQL:
 * which folders belong to which tree, which assignments make a recording
 * shared, what an unshare deletes, and whether a run that outlives an unshare
 * still writes. Mocked query builders can only prove the right functions were
 * called, so these run against a migrated scratch database.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { and, eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    accounts,
    aiEnhancements,
    asyncJobs,
    people,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
    transcriptSpeakers,
    userSettings,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, hooks } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current) {
                    throw new Error("test database was not initialized");
                }
                const value = current[property];
                return typeof value === "function"
                    ? value.bind(current)
                    : value;
            },
        },
    );
    return {
        dbProxy: proxy,
        dbRef: ref,
        // Run once, inside the next share, right after it made the names
        // the Organization's.
        hooks: { afterPublish: null as null | (() => Promise<void>) },
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared" as "shared" | "local",
            ORG_ACCOUNT_EMAIL: "org@example.test" as string | undefined,
            ORG_ACCOUNT_PASSWORD: "organization-password" as string | undefined,
            ORG_ACCOUNT_NAME: undefined as string | undefined,
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
// Another writer arriving while a share holds its locks.
vi.mock("@/lib/sharing/share-names", async () => {
    const actual = await vi.importActual<
        typeof import("@/lib/sharing/share-names")
    >("@/lib/sharing/share-names");
    return {
        ...actual,
        publishSpeakerNamesInTx: async (
            ...args: Parameters<typeof actual.publishSpeakerNamesInTx>
        ) => {
            const promoted = await actual.publishSpeakerNamesInTx(...args);
            const run = hooks.afterPublish;
            hooks.afterPublish = null;
            await run?.();
            return promoted;
        },
    };
});

import { db as appDb } from "@/db";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError } from "@/lib/errors";
import {
    addRecordingToFolder,
    createFolder,
    deleteFolder,
    listFolderOrganization,
    moveFolder,
    moveRecordingBetweenFolders,
    removeRecordingFromFolder,
    renameFolder,
    retireLegacyPublicRoots,
    unshareRecording,
} from "@/lib/folders/folders";
import {
    deleteSpeakerInTx,
    lockForSpeakerChange,
} from "@/lib/knowledge/attribution";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { deletePerson, mergePeople } from "@/lib/knowledge/people";
import { changeTranscriptSpeaker } from "@/lib/knowledge/speaker-changes";
import { ensureOrgAccount } from "@/lib/org/account";
import {
    requireRecordingView,
    resolveRecordingAccess,
} from "@/lib/sharing/access";
import { upsertTranscription } from "@/lib/transcription/persist";
import { storeBrowserTranscription } from "@/lib/transcription/transcribe-recording";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

type Tx = Parameters<Parameters<typeof appDb.transaction>[0]>[0];

/**
 * Run `work` in a transaction that stays open, holding its locks, until
 * `commit` is called: another writer caught in the middle of its work.
 */
async function holdTransaction(work: (tx: Tx) => Promise<void>) {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    let ready = () => {};
    const worked = new Promise<void>((resolve) => {
        ready = resolve;
    });
    const done = appDb.transaction(async (tx) => {
        await work(tx);
        ready();
        await released;
    });
    await Promise.race([worked, done]);
    return {
        commit: async () => {
            release();
            await done;
        },
    };
}

/** Whether `promise` is still pending after a moment: waiting on a lock. */
async function stillWaiting(promise: Promise<unknown>): Promise<boolean> {
    const pending = Symbol("pending");
    const first = await Promise.race([
        promise.then(
            () => null,
            () => null,
        ),
        new Promise((resolve) => setTimeout(() => resolve(pending), 300)),
    ]);
    return first === pending;
}

async function expectStatus(promise: Promise<unknown>, status: number) {
    const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(status);
}

describeWithDatabase("Organization scope (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "org_scope",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        mockEnv.ORG_ACCOUNT_EMAIL = "org@example.test";
        mockEnv.ORG_ACCOUNT_PASSWORD = "organization-password";
        mockEnv.SELF_HOST_MODE = "shared";
        await db().delete(asyncJobs);
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test", name: "Alice" },
                { id: BOB, email: "bob@example.test", name: "Bob" },
            ]);
    });

    async function insertRecording(
        id: string,
        userId: string,
        { transcribed = true }: { transcribed?: boolean } = {},
    ) {
        await insertRecordings(db(), {
            id,
            userId,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText(`Recording ${id}`),
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 1000,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${userId}/${id}.mp3`,
            plaudVersion: "1",
        });
        // Transcribed, without speakers: nothing stands in the way of
        // sharing it.
        if (transcribed) await insertTranscript(id, userId);
    }

    async function insertTranscript(
        recordingId: string,
        userId: string,
        {
            text = "Hello.",
            model = "whisper-1",
            source = "riffado",
        }: { text?: string; model?: string; source?: string } = {},
    ): Promise<string> {
        const [row] = await db()
            .insert(transcriptions)
            .values({
                recordingId,
                userId,
                text: encryptText(text),
                provider: "openai",
                model,
                source,
            })
            .returning({ id: transcriptions.id });
        return row?.id ?? "";
    }

    async function orgRootId(): Promise<string> {
        const orgUserId = await ensureOrgAccount();
        if (!orgUserId) throw new Error("organization account missing");
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        if (!root) throw new Error("organization root missing");
        return root.id;
    }

    async function orgUser(): Promise<string> {
        const id = await ensureOrgAccount();
        if (!id) throw new Error("organization account missing");
        return id;
    }

    describe("organization account", () => {
        it("creates one account with a credential, settings and the Organization root", async () => {
            const first = await ensureOrgAccount();
            const second = await ensureOrgAccount();
            expect(first).toBeTruthy();
            expect(second).toBe(first);

            const [row] = await db()
                .select()
                .from(users)
                .where(eq(users.role, "org"));
            expect(row?.email).toBe("org@example.test");
            const credential = await db()
                .select()
                .from(accounts)
                .where(eq(accounts.userId, first ?? ""));
            expect(credential).toHaveLength(1);
            expect(credential[0]?.providerId).toBe("credential");
            expect(credential[0]?.password).not.toBe("organization-password");
            const [settings] = await db()
                .select()
                .from(userSettings)
                .where(eq(userSettings.userId, first ?? ""));
            expect(settings?.onboardingCompleted).toBe(true);
            const roots = await db()
                .select()
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, first ?? ""));
            expect(roots).toHaveLength(1);
            expect(roots[0]?.kind).toBe("public");
        });

        it("renames the one account when the configured email changes", async () => {
            const first = await ensureOrgAccount();
            mockEnv.ORG_ACCOUNT_EMAIL = "team@example.test";
            const second = await ensureOrgAccount();
            expect(second).toBe(first);
            const orgRows = await db()
                .select()
                .from(users)
                .where(eq(users.role, "org"));
            expect(orgRows).toHaveLength(1);
            expect(orgRows[0]?.email).toBe("team@example.test");
        });

        it("never takes over a regular account's email", async () => {
            mockEnv.ORG_ACCOUNT_EMAIL = "alice@example.test";
            await expect(ensureOrgAccount()).rejects.toThrow(
                /already belongs to a regular account/,
            );
            const [alice] = await db()
                .select()
                .from(users)
                .where(eq(users.id, ALICE));
            expect(alice?.role).toBe("user");
        });

        it("does nothing when the scope is not enabled", async () => {
            mockEnv.SELF_HOST_MODE = "local";
            expect(await ensureOrgAccount()).toBeNull();
        });
    });

    describe("retiring per-user Public roots", () => {
        it("deletes empty ones and moves the rest into Private as Former Public", async () => {
            await insertRecording("rec-a", ALICE);
            const legacy = (userId: string) => ({
                userId,
                parentId: null,
                name: encryptText("Public"),
                nameHash: lookupHash("Public"),
                kind: "public" as const,
                sortOrder: 1000,
            });
            const [alicePublic] = await db()
                .insert(recordingFolders)
                .values(legacy(ALICE))
                .returning();
            await db().insert(recordingFolders).values(legacy(BOB));
            await db()
                .insert(recordingFolderAssignments)
                .values({
                    userId: ALICE,
                    itemId: "rec-a",
                    folderId: alicePublic?.id ?? "",
                });

            const retired = await db().transaction((tx) =>
                retireLegacyPublicRoots(tx),
            );
            expect(retired).toBe(2);

            const bobFolders = await db()
                .select()
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, BOB));
            expect(bobFolders).toHaveLength(0);

            const aliceFolders = await db()
                .select()
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, ALICE));
            const privateRoot = aliceFolders.find((f) => f.kind === "private");
            const former = aliceFolders.find((f) => f.id === alicePublic?.id);
            expect(privateRoot).toBeDefined();
            expect(former?.kind).toBe("custom");
            expect(former?.parentId).toBe(privateRoot?.id);
            expect(decryptText(former?.name ?? "")).toBe("Former Public");

            // Nothing is shared by the upgrade: the recording stays Alice's.
            const orgRoot = await orgRootId();
            expect(await resolveRecordingAccess(BOB, "rec-a")).toBeNull();
            expect(orgRoot).toBeTruthy();
        });
    });

    describe("sharing and access", () => {
        it("resolves roles only while a recording is shared", async () => {
            await insertRecording("rec-a", ALICE);
            const root = await orgRootId();
            const org = await orgUser();

            expect((await resolveRecordingAccess(ALICE, "rec-a"))?.role).toBe(
                "owner",
            );
            expect(await resolveRecordingAccess(BOB, "rec-a")).toBeNull();
            expect(await resolveRecordingAccess(org, "rec-a")).toBeNull();

            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: root,
            });

            expect((await resolveRecordingAccess(BOB, "rec-a"))?.role).toBe(
                "member",
            );
            expect((await resolveRecordingAccess(org, "rec-a"))?.role).toBe(
                "curator",
            );
            await expectStatus(
                requireRecordingView(BOB, "rec-a", "private"),
                404,
            );
            // One recording: the Organization view reads the owner's rows.
            const view = await requireRecordingView(BOB, "rec-a", "org");
            expect(view.contentUserId).toBe(ALICE);
            expect(view.ownerUserId).toBe(ALICE);
            expect(view.orgUserId).toBe(org);
        });

        it("lets only the owner share", async () => {
            await insertRecording("rec-a", ALICE);
            const root = await orgRootId();
            await expectStatus(
                addRecordingToFolder({
                    userId: BOB,
                    recordingId: "rec-a",
                    folderId: root,
                }),
                404,
            );
            expect(await resolveRecordingAccess(BOB, "rec-a")).toBeNull();
        });

        it("keeps private folders private while the Organization tree is shared", async () => {
            await insertRecording("rec-a", ALICE);
            await insertRecording("rec-b", BOB);
            const root = await orgRootId();
            const aliceTree = await listFolderOrganization(ALICE);
            const alicePrivate = aliceTree.folders.find(
                (f) => f.kind === "private",
            );
            if (!alicePrivate) throw new Error("private root missing");
            const secret = await createFolder({
                userId: ALICE,
                parentId: alicePrivate.id,
                name: "HR",
            });
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: secret.id,
            });
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: root,
            });

            const bobTree = await listFolderOrganization(BOB);
            expect(bobTree.folders.map((f) => f.id)).not.toContain(secret.id);
            expect(bobTree.assignments).toEqual([
                { recordingId: "rec-a", folderId: root },
            ]);
            expect(
                bobTree.folders.filter((f) => f.scope === "org"),
            ).toHaveLength(1);

            const orgTree = await listFolderOrganization(await orgUser());
            expect(orgTree.folders.every((f) => f.scope === "org")).toBe(true);
            expect(orgTree.assignments).toEqual([
                { recordingId: "rec-a", folderId: root },
            ]);

            await expectStatus(
                renameFolder({ userId: BOB, folderId: secret.id, name: "x" }),
                404,
            );
        });
    });

    describe("private folders stay their owner's", () => {
        async function aliceFolder(name: string) {
            const tree = await listFolderOrganization(ALICE);
            const root = tree.folders.find((f) => f.kind === "private");
            if (!root) throw new Error("private root missing");
            return createFolder({ userId: ALICE, parentId: root.id, name });
        }

        it("refuses another account's assignment, removal, move and deletion", async () => {
            await insertRecording("rec-a", ALICE);
            await insertRecording("rec-b", BOB);
            const meetings = await aliceFolder("Meetings");
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: meetings.id,
            });

            await expectStatus(
                addRecordingToFolder({
                    userId: BOB,
                    recordingId: "rec-b",
                    folderId: meetings.id,
                }),
                404,
            );
            await removeRecordingFromFolder({
                userId: BOB,
                recordingId: "rec-a",
                folderId: meetings.id,
            });
            await expectStatus(deleteFolder(BOB, meetings.id), 404);
            const bobTree = await listFolderOrganization(BOB);
            const bobRoot = bobTree.folders.find((f) => f.kind === "private");
            await expectStatus(
                moveFolder({
                    userId: BOB,
                    folderId: meetings.id,
                    parentId: bobRoot?.id ?? "",
                }),
                404,
            );

            const assignments = await db()
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.folderId, meetings.id));
            expect(assignments).toHaveLength(1);
            const [folder] = await db()
                .select()
                .from(recordingFolders)
                .where(eq(recordingFolders.id, meetings.id));
            expect(folder?.userId).toBe(ALICE);
        });

        it("persists sibling order and never crosses into the Organization tree", async () => {
            const first = await aliceFolder("First");
            const second = await aliceFolder("Second");
            const tree = await listFolderOrganization(ALICE);
            const root = tree.folders.find((f) => f.kind === "private");
            const moved = await moveFolder({
                userId: ALICE,
                folderId: second.id,
                parentId: root?.id ?? "",
                beforeId: first.id,
            });
            expect(moved.sortOrder).toBe(0);
            const [firstRow] = await db()
                .select()
                .from(recordingFolders)
                .where(eq(recordingFolders.id, first.id));
            expect(firstRow?.sortOrder).toBe(1000);

            const orgRoot = await orgRootId();
            await expectStatus(
                moveFolder({
                    userId: ALICE,
                    folderId: first.id,
                    parentId: orgRoot,
                }),
                404,
            );
        });
    });

    describe("the Organization tree", () => {
        it("is edited by everyone, with a version check", async () => {
            const root = await orgRootId();
            const folder = await createFolder({
                userId: BOB,
                parentId: root,
                name: "Sales",
            });
            expect(folder.scope).toBe("org");
            const [row] = await db()
                .select()
                .from(recordingFolders)
                .where(eq(recordingFolders.id, folder.id));
            expect(row?.createdByUserId).toBe(BOB);
            expect(row?.userId).toBe(await orgUser());

            const renamed = await renameFolder({
                userId: ALICE,
                folderId: folder.id,
                name: "Sales EU",
                version: folder.version,
            });
            expect(renamed.version).toBe(folder.version + 1);
            await expectStatus(
                renameFolder({
                    userId: BOB,
                    folderId: folder.id,
                    name: "Sales US",
                    version: folder.version,
                }),
                409,
            );
        });

        it("survives the deletion of the account that created a folder", async () => {
            const root = await orgRootId();
            const folder = await createFolder({
                userId: BOB,
                parentId: root,
                name: "Sales",
            });
            await db().delete(users).where(eq(users.id, BOB));
            const [row] = await db()
                .select()
                .from(recordingFolders)
                .where(eq(recordingFolders.id, folder.id));
            expect(row).toBeDefined();
            expect(row?.createdByUserId).toBeNull();
        });

        it("refiles a deleted folder's recordings in the Organization root", async () => {
            await insertRecording("rec-a", ALICE);
            const root = await orgRootId();
            const sales = await createFolder({
                userId: ALICE,
                parentId: root,
                name: "Sales",
            });
            const eu = await createFolder({
                userId: ALICE,
                parentId: sales.id,
                name: "EU",
            });
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: eu.id,
            });

            await deleteFolder(BOB, sales.id);

            const assignments = await db()
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "rec-a"));
            expect(assignments).toEqual([
                expect.objectContaining({ folderId: root, userId: ALICE }),
            ]);
            expect((await resolveRecordingAccess(BOB, "rec-a"))?.role).toBe(
                "member",
            );
        });

        it("lets anyone move a shared recording but only the owner withdraw it", async () => {
            await insertRecording("rec-a", ALICE);
            const root = await orgRootId();
            const sales = await createFolder({
                userId: ALICE,
                parentId: root,
                name: "Sales",
            });
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: root,
            });

            await moveRecordingBetweenFolders({
                userId: BOB,
                recordingId: "rec-a",
                fromFolderId: root,
                toFolderId: sales.id,
            });
            const moved = await db()
                .select()
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "rec-a"));
            expect(moved.map((row) => row.folderId)).toEqual([sales.id]);
            expect(moved[0]?.userId).toBe(ALICE);

            await expectStatus(
                removeRecordingFromFolder({
                    userId: BOB,
                    recordingId: "rec-a",
                    folderId: sales.id,
                }),
                403,
            );
            await expectStatus(
                unshareRecording(BOB, "rec-a", { withdraw: true }),
                403,
            );
            expect((await resolveRecordingAccess(BOB, "rec-a"))?.role).toBe(
                "member",
            );
        });

        it("gives the recording back as the Organization left it, and cancels its jobs, on unshare", async () => {
            await insertRecording("rec-a", ALICE);
            const root = await orgRootId();
            const org = await orgUser();
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: root,
            });
            await upsertTranscription({
                userId: ALICE,
                actorUserId: org,
                recordingId: "rec-a",
                text: "shared transcript",
                detectedLanguage: "en",
                source: "riffado",
                provider: "openai",
                model: "whisper-1",
                allowReaped: true,
            });
            await db()
                .insert(asyncJobs)
                .values({
                    userId: BOB,
                    kind: "summary",
                    subjectId: "org:rec-a",
                    payload: { recordingId: "rec-a", view: "org" },
                });

            await unshareRecording(ALICE, "rec-a", { withdraw: true });

            const rows = await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, "rec-a"));
            expect(
                rows.map((row) => [
                    row.userId,
                    row.producedByUserId,
                    decryptText(row.text),
                ]),
            ).toEqual([[ALICE, org, "shared transcript"]]);
            const [job] = await db().select().from(asyncJobs);
            expect(job?.status).toBe("failed");
            expect(await resolveRecordingAccess(BOB, "rec-a")).toBeNull();
        });
    });

    describe("read-only Organization", () => {
        it("stays readable but refuses changes once its account is unconfigured", async () => {
            await insertRecording("rec-a", ALICE);
            const root = await orgRootId();
            const sales = await createFolder({
                userId: BOB,
                parentId: root,
                name: "Sales",
            });
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: root,
            });
            mockEnv.ORG_ACCOUNT_EMAIL = undefined;
            mockEnv.ORG_ACCOUNT_PASSWORD = undefined;

            const tree = await listFolderOrganization(BOB);
            expect(tree.folders.some((f) => f.id === sales.id)).toBe(true);
            expect((await resolveRecordingAccess(BOB, "rec-a"))?.role).toBe(
                "member",
            );
            await expectStatus(
                createFolder({ userId: BOB, parentId: root, name: "New" }),
                403,
            );
            await expectStatus(
                renameFolder({ userId: BOB, folderId: sales.id, name: "x" }),
                403,
            );
            await expectStatus(deleteFolder(BOB, sales.id), 403);
            await expectStatus(
                moveRecordingBetweenFolders({
                    userId: BOB,
                    recordingId: "rec-a",
                    fromFolderId: root,
                    toFolderId: sales.id,
                }),
                403,
            );
            // Withdrawing is still the owner's right.
            await unshareRecording(ALICE, "rec-a", { withdraw: true });
            expect(await resolveRecordingAccess(BOB, "rec-a")).toBeNull();
        });

        it("keeps the organization account's own folders out of reach in local mode", async () => {
            const root = await orgRootId();
            const org = await orgUser();
            const sales = await createFolder({
                userId: BOB,
                parentId: root,
                name: "Sales",
            });
            mockEnv.SELF_HOST_MODE = "local";
            await expectStatus(
                renameFolder({ userId: org, folderId: sales.id, name: "x" }),
                403,
            );
            await expectStatus(deleteFolder(org, sales.id), 403);
            expect((await listFolderOrganization(BOB)).folders).toHaveLength(1);
        });
    });

    describe("concurrent Organization changes", () => {
        it("never leaves a recording shared after its owner's unshare succeeded", async () => {
            await insertRecording("rec-a", ALICE);
            const root = await orgRootId();
            const sales = await createFolder({
                userId: BOB,
                parentId: root,
                name: "Sales",
            });
            for (let round = 0; round < 8; round += 1) {
                await addRecordingToFolder({
                    userId: ALICE,
                    recordingId: "rec-a",
                    folderId: root,
                });
                const [unshared] = await Promise.allSettled([
                    unshareRecording(ALICE, "rec-a", { withdraw: true }),
                    moveRecordingBetweenFolders({
                        userId: BOB,
                        recordingId: "rec-a",
                        fromFolderId: root,
                        toFolderId: sales.id,
                    }),
                ]);
                expect(unshared.status).toBe("fulfilled");
                expect(await resolveRecordingAccess(BOB, "rec-a")).toBeNull();
            }
        });
    });

    describe("changing a shared recording", () => {
        it("lets the organization account rewrite the owner's rows, recording who produced them", async () => {
            await insertRecording("rec-a", ALICE);
            const root = await orgRootId();
            const org = await orgUser();
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: root,
            });
            const { committed } = await upsertTranscription({
                userId: ALICE,
                actorUserId: org,
                recordingId: "rec-a",
                text: "shared transcript",
                detectedLanguage: "en",
                source: "riffado",
                provider: "openai",
                model: "whisper-1",
            });
            expect(committed).toBe(true);
            const rows = await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, "rec-a"));
            expect(
                rows.map((row) => [
                    row.userId,
                    row.producedByUserId,
                    decryptText(row.text),
                ]),
            ).toEqual([[ALICE, org, "shared transcript"]]);
        });

        it("refuses the owner's and a member's writes while shared", async () => {
            await insertRecording("rec-a", ALICE);
            const root = await orgRootId();
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: root,
            });
            for (const actorUserId of [ALICE, BOB]) {
                expect(
                    await upsertTranscription({
                        userId: ALICE,
                        actorUserId,
                        recordingId: "rec-a",
                        text: "not theirs to write",
                        detectedLanguage: "en",
                        source: "riffado",
                        provider: "openai",
                        model: "whisper-1",
                    }),
                ).toEqual({ committed: false, reason: "shared" });
            }
        });

        it("writes nothing for the organization account once the recording is no longer shared", async () => {
            await insertRecording("rec-a", ALICE);
            const org = await orgUser();
            const { committed, reason } = await upsertTranscription({
                userId: ALICE,
                actorUserId: org,
                recordingId: "rec-a",
                text: "too late",
                detectedLanguage: "en",
                source: "riffado",
                provider: "openai",
                model: "whisper-1",
            });
            expect({ committed, reason }).toEqual({
                committed: false,
                reason: "withdrawn",
            });
            const rows = await db().select().from(aiEnhancements);
            expect(rows).toHaveLength(0);
            const owned = await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.userId, ALICE));
            expect(owned.map((item) => decryptText(item.text))).toEqual([
                "Hello.",
            ]);
        });
    });

    describe("sharing is gated on the owner's rows", () => {
        const DIARIZED = "gpt-4o-transcribe-diarize";
        const DIALOG = "speaker_0: Hello.\nspeaker_1: Hi there.";

        /** Alice's recording with a diarized transcript per source. */
        async function meeting(sources = ["riffado"]) {
            await insertRecording("rec-a", ALICE, { transcribed: false });
            const ids: Record<string, string> = {};
            for (const source of sources) {
                ids[source] = await insertTranscript("rec-a", ALICE, {
                    text: DIALOG,
                    model: DIARIZED,
                    source,
                });
            }
            return ids;
        }

        async function person(name: string): Promise<string> {
            const [row] = await db()
                .insert(people)
                .values({ userId: ALICE, displayName: encryptText(name) })
                .returning({ id: people.id });
            return row?.id ?? "";
        }

        /** Alice's answer: a person, or unknown when null. */
        async function answer(
            transcriptionId: string,
            label: string,
            personId: string | null,
        ) {
            await db()
                .insert(transcriptSpeakers)
                .values({
                    userId: ALICE,
                    transcriptionId,
                    label,
                    personId,
                    markedUnknown: personId === null,
                    source: "user",
                    status: "confirmed",
                    confirmedByUserId: ALICE,
                });
        }

        /** A meeting whose speakers are Jana and someone unknown. */
        async function answeredMeeting() {
            const { riffado } = await meeting();
            const jana = await person("Jana");
            await answer(riffado ?? "", "speaker_0", jana);
            await answer(riffado ?? "", "speaker_1", null);
            return { transcript: riffado ?? "", jana };
        }

        async function share(folderId?: string) {
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: folderId ?? (await orgRootId()),
            });
        }

        async function refusal(promise: Promise<unknown>) {
            const error = await promise.then(
                () => null,
                (caught: unknown) => caught,
            );
            expect(error).toBeInstanceOf(AppError);
            return error as AppError;
        }

        /** The speaker names the recording carries, which the Organization reads. */
        async function sharedNames() {
            return db()
                .select({
                    label: transcriptSpeakers.label,
                    personId: transcriptSpeakers.personId,
                    markedUnknown: transcriptSpeakers.markedUnknown,
                    confirmedByUserId: transcriptSpeakers.confirmedByUserId,
                })
                .from(transcriptSpeakers)
                .where(eq(transcriptSpeakers.userId, ALICE))
                .orderBy(transcriptSpeakers.label);
        }

        /** The rows the organization account owns: none, ever. */
        async function orgOwnedRows() {
            const org = await orgUser();
            return [
                ...(await db()
                    .select({ id: transcriptions.id })
                    .from(transcriptions)
                    .where(eq(transcriptions.userId, org))),
                ...(await db()
                    .select({ id: aiEnhancements.id })
                    .from(aiEnhancements)
                    .where(eq(aiEnhancements.userId, org))),
            ];
        }

        async function assignments() {
            return db()
                .select({ folderId: recordingFolderAssignments.folderId })
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.itemId, "rec-a"));
        }

        async function ownerOf(personId: string) {
            const [row] = await db()
                .select({ userId: people.userId })
                .from(people)
                .where(eq(people.id, personId));
            return row?.userId ?? null;
        }

        it("refuses a speaker nobody named, and leaves nothing behind", async () => {
            const { riffado } = await meeting();
            const jana = await person("Jana");
            await answer(riffado ?? "", "speaker_0", jana);

            const error = await refusal(share());

            expect(error.statusCode).toBe(409);
            expect(error.code).toBe("SHARE_REQUIREMENTS_UNMET");
            expect(error.details).toEqual({
                problems: [
                    {
                        kind: "unresolved_speakers",
                        source: "riffado",
                        labels: ["speaker_1"],
                    },
                ],
            });
            expect(await assignments()).toEqual([]);
            expect(await ownerOf(jana)).toBe(ALICE);
            expect(await resolveRecordingAccess(BOB, "rec-a")).toBeNull();
        });

        it("refuses a recording without a transcript", async () => {
            await insertRecording("rec-a", ALICE, { transcribed: false });
            const error = await refusal(share());
            expect(error.details).toEqual({
                problems: [{ kind: "no_transcript" }],
            });
            expect(await assignments()).toEqual([]);
        });

        it("shares a recording whose every speaker is answered, its names made the Organization's", async () => {
            const { riffado, plaud } = await meeting(["riffado", "plaud"]);
            const jana = await person("Jana");
            for (const id of [riffado ?? "", plaud ?? ""]) {
                await answer(id, "speaker_0", jana);
                await answer(id, "speaker_1", null);
            }
            await db()
                .insert(aiEnhancements)
                .values({
                    itemId: "rec-a",
                    userId: ALICE,
                    transcriptionId: riffado,
                    summary: encryptText("What was said"),
                    provider: "openai",
                    model: "gpt",
                    source: "riffado",
                });

            await share();

            expect(await assignments()).toHaveLength(1);
            // One recording: its rows stay the owner's, as they were.
            expect(await orgOwnedRows()).toEqual([]);
            expect(await sharedNames()).toEqual(
                [jana, jana, null, null].map((personId, index) => ({
                    label: index < 2 ? "speaker_0" : "speaker_1",
                    personId,
                    markedUnknown: personId === null,
                    confirmedByUserId: ALICE,
                })),
            );
            expect(await ownerOf(jana)).toBe(await orgUser());
            const view = await requireRecordingView(BOB, "rec-a", "org");
            expect(view.contentUserId).toBe(ALICE);
        });

        it("files a shared recording into another Organization folder without the gate", async () => {
            await answeredMeeting();
            await share();
            const sales = await createFolder({
                userId: BOB,
                parentId: await orgRootId(),
                name: "Sales",
            });
            // A transcript nobody answered for, written around the share.
            await insertTranscript("rec-a", ALICE, {
                text: DIALOG,
                model: DIARIZED,
                source: "plaud",
            });

            await share(sales.id);

            // Filed in Sales, which makes the root assignment redundant.
            expect(await assignments()).toEqual([{ folderId: sales.id }]);
        });

        it("gates and publishes the names again when shared again", async () => {
            const { transcript } = await answeredMeeting();
            await share();
            await unshareRecording(ALICE, "rec-a", { withdraw: true });

            // The owner's again, to change: a private person on it now.
            const petr = await person("Petr");
            await db()
                .update(transcriptSpeakers)
                .set({ personId: petr, markedUnknown: false })
                .where(
                    and(
                        eq(transcriptSpeakers.transcriptionId, transcript),
                        eq(transcriptSpeakers.label, "speaker_1"),
                    ),
                );
            await share();

            expect(
                (await sharedNames()).find((row) => row.label === "speaker_1")
                    ?.personId,
            ).toBe(petr);
            expect(await ownerOf(petr)).toBe(await orgUser());
        });

        it("publishes nobody through rows on labels the text no longer has", async () => {
            const { transcript } = await answeredMeeting();
            const contact = await person("A private contact");
            const guess = await person("Maybe Karel");
            // Left from an earlier diarization: labels the text lacks, so
            // the gate never judged them.
            await db()
                .insert(transcriptSpeakers)
                .values([
                    {
                        userId: ALICE,
                        transcriptionId: transcript,
                        label: "speaker_8",
                        personId: contact,
                        source: "user" as const,
                        status: "confirmed" as const,
                        confirmedByUserId: ALICE,
                    },
                    {
                        userId: ALICE,
                        transcriptionId: transcript,
                        label: "speaker_9",
                        personId: guess,
                        source: "heuristic" as const,
                        status: "suggested" as const,
                    },
                ]);

            await share();

            expect(
                (await sharedNames()).map((row) => row.label).sort(),
            ).toEqual(["speaker_0", "speaker_1"]);
            expect(await ownerOf(contact)).toBe(ALICE);
            expect(await ownerOf(guess)).toBe(ALICE);
        });

        describe("racing a share", () => {
            // The organization account and its root exist before a race
            // starts: creating them hashes a password, which would make a
            // waiting share look like one waiting on a lock.
            let root = "";
            beforeEach(async () => {
                root = await orgRootId();
            });

            it("refuses when a speaker's answer is taken back first", async () => {
                const { transcript } = await answeredMeeting();
                const clearing = await holdTransaction(async (tx) => {
                    await lockForSpeakerChange(tx, {
                        userId: ALICE,
                        transcriptionId: transcript,
                        revision: 0,
                    });
                    await deleteSpeakerInTx(tx, {
                        userId: ALICE,
                        transcriptionId: transcript,
                        label: "speaker_1",
                    });
                });

                const sharing = share(root);
                expect(await stillWaiting(sharing)).toBe(true);
                await clearing.commit();

                expect((await refusal(sharing)).statusCode).toBe(409);
                expect(await assignments()).toEqual([]);
            });

            it("shares the answer, and refuses taking it back, when that comes after the share", async () => {
                const { transcript } = await answeredMeeting();
                let clearing: Promise<unknown> = Promise.resolve();
                hooks.afterPublish = async () => {
                    clearing = changeTranscriptSpeaker({
                        userId: ALICE,
                        transcriptionId: transcript,
                        revision: 0,
                        label: "speaker_1",
                        answer: { kind: "clear" },
                        actorUserId: ALICE,
                        orgUserId: await orgUser(),
                    });
                    expect(await stillWaiting(clearing)).toBe(true);
                };

                await share(root);

                const error = await refusal(clearing);
                expect(error.code).toBe("RECORDING_SHARED");
                const [own] = await db()
                    .select()
                    .from(transcriptSpeakers)
                    .where(
                        and(
                            eq(transcriptSpeakers.transcriptionId, transcript),
                            eq(transcriptSpeakers.label, "speaker_1"),
                        ),
                    );
                expect(own?.markedUnknown).toBe(true);
            });

            it("refuses a transcript from the browser that waited for the share", async () => {
                const { transcript } = await answeredMeeting();
                let storing: Promise<{ errorCode?: string }> = Promise.resolve(
                    {},
                );
                hooks.afterPublish = async () => {
                    storing = storeBrowserTranscription({
                        userId: ALICE,
                        recordingId: "rec-a",
                        text: "Made in the browser.",
                        detectedLanguage: null,
                        model: "whisper-base",
                    });
                    expect(await stillWaiting(storing)).toBe(true);
                };

                await share(root);

                expect((await storing).errorCode).toBe("RECORDING_SHARED");
                const [own] = await db()
                    .select({ text: transcriptions.text })
                    .from(transcriptions)
                    .where(eq(transcriptions.id, transcript));
                expect(decryptText(own?.text ?? "")).toBe(DIALOG);
            });

            it("refuses when a named person is deleted first", async () => {
                const { jana } = await answeredMeeting();
                // deletePerson, caught between its delete and its commit.
                const deleting = await holdTransaction(async (tx) => {
                    await lockOrgPeople(tx);
                    await tx.delete(people).where(eq(people.id, jana));
                });

                const sharing = share(root);
                expect(await stillWaiting(sharing)).toBe(true);
                await deleting.commit();

                expect((await refusal(sharing)).statusCode).toBe(409);
                expect(await assignments()).toEqual([]);
            });

            it("shares the name when the person's deletion comes after the share", async () => {
                const { jana } = await answeredMeeting();
                let deleting: Promise<unknown> = Promise.resolve();
                hooks.afterPublish = async () => {
                    deleting = deletePerson(ALICE, jana);
                    expect(await stillWaiting(deleting)).toBe(true);
                };

                await share(root);

                // By then an Organization person, not the owner's to delete.
                expect((await refusal(deleting)).statusCode).toBe(403);
                expect(await ownerOf(jana)).toBe(await orgUser());
                expect(
                    (await sharedNames()).find(
                        (row) => row.label === "speaker_0",
                    )?.personId,
                ).toBe(jana);
            });

            it("never publishes a private person a merge moved the named one into", async () => {
                const { jana } = await answeredMeeting();
                const privateJana = await person("Jana (mine)");
                let merging: Promise<unknown> = Promise.resolve();
                hooks.afterPublish = async () => {
                    merging = mergePeople(ALICE, privateJana, jana);
                    expect(await stillWaiting(merging)).toBe(true);
                };

                await share(root);

                // By then Jana is the Organization's, not the owner's to
                // fold into a private record.
                expect((await refusal(merging)).statusCode).toBe(403);
                const named = (await sharedNames()).find(
                    (row) => row.label === "speaker_0",
                );
                expect(named?.personId).toBe(jana);
                expect(await ownerOf(jana)).toBe(await orgUser());
            });
        });
    });
});
