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
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
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
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { ensureOrgAccount } from "@/lib/org/account";
import {
    requireRecordingView,
    resolveRecordingAccess,
} from "@/lib/sharing/access";
import { upsertTranscription } from "@/lib/transcription/persist";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

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

    async function insertRecording(id: string, userId: string) {
        await db()
            .insert(recordings)
            .values({
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
                    recordingId: "rec-a",
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
            const view = await requireRecordingView(BOB, "rec-a", "org");
            expect(view.contentUserId).toBe(org);
            expect(view.ownerUserId).toBe(ALICE);
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
                .where(eq(recordingFolderAssignments.recordingId, "rec-a"));
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
                .where(eq(recordingFolderAssignments.recordingId, "rec-a"));
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
            await expectStatus(unshareRecording(BOB, "rec-a"), 403);
            expect((await resolveRecordingAccess(BOB, "rec-a"))?.role).toBe(
                "member",
            );
        });

        it("deletes the Organization view and cancels its jobs on unshare", async () => {
            await insertRecording("rec-a", ALICE);
            const root = await orgRootId();
            const org = await orgUser();
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: root,
            });
            await upsertTranscription({
                userId: org,
                recordingOwnerId: ALICE,
                producedByUserId: BOB,
                recordingId: "rec-a",
                text: "shared transcript",
                detectedLanguage: "en",
                source: "riffado",
                provider: "openai",
                model: "whisper-1",
            });
            await upsertTranscription({
                userId: ALICE,
                recordingId: "rec-a",
                text: "private transcript",
                detectedLanguage: "en",
                source: "riffado",
                provider: "openai",
                model: "whisper-1",
            });
            await db()
                .insert(asyncJobs)
                .values({
                    userId: BOB,
                    kind: "summary",
                    subjectId: "org:rec-a",
                    payload: { recordingId: "rec-a", view: "org" },
                });

            await unshareRecording(ALICE, "rec-a");

            const rows = await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, "rec-a"));
            expect(rows.map((row) => row.userId)).toEqual([ALICE]);
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
            await unshareRecording(ALICE, "rec-a");
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
                    unshareRecording(ALICE, "rec-a"),
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

    describe("writing the Organization view", () => {
        it("records who produced the row and never touches the owner's", async () => {
            await insertRecording("rec-a", ALICE);
            const root = await orgRootId();
            const org = await orgUser();
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: "rec-a",
                folderId: root,
            });
            const { committed } = await upsertTranscription({
                userId: org,
                recordingOwnerId: ALICE,
                producedByUserId: BOB,
                recordingId: "rec-a",
                text: "shared transcript",
                detectedLanguage: "en",
                source: "riffado",
                provider: "openai",
                model: "whisper-1",
            });
            expect(committed).toBe(true);
            const [row] = await db()
                .select()
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, "rec-a"),
                        eq(transcriptions.userId, org),
                    ),
                );
            expect(row?.producedByUserId).toBe(BOB);
            expect(decryptText(row?.text ?? "")).toBe("shared transcript");
            const owned = await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.userId, ALICE));
            expect(owned).toHaveLength(0);
        });

        it("writes nothing once the recording is no longer shared", async () => {
            await insertRecording("rec-a", ALICE);
            const org = await orgUser();
            const { committed } = await upsertTranscription({
                userId: org,
                recordingOwnerId: ALICE,
                producedByUserId: BOB,
                recordingId: "rec-a",
                text: "too late",
                detectedLanguage: "en",
                source: "riffado",
                provider: "openai",
                model: "whisper-1",
            });
            expect(committed).toBe(false);
            const rows = await db().select().from(aiEnhancements);
            expect(rows).toHaveLength(0);
            const transcripts = await db().select().from(transcriptions);
            expect(transcripts).toHaveLength(0);
        });
    });
});
