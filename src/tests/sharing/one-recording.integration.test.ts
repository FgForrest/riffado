/**
 * A shared recording is one recording, against a real PostgreSQL: the
 * Organization view reads the owner's rows, only the organization account
 * changes them while it is shared, and a withdrawal gives them back to the
 * owner as the Organization left them.
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
    aiEnhancements,
    apiCredentials,
    chatterItems,
    recordingFolders,
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
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

const { createCompletion } = vi.hoisted(() => ({
    createCompletion: vi.fn(),
}));
vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("openai")>();
    return {
        ...actual,
        OpenAI: class {
            chat = { completions: { create: createCompletion } };
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/export/document-sidecars", () => ({
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        exists: vi.fn().mockResolvedValue(false),
        deleteFile: vi.fn().mockResolvedValue(undefined),
    }),
}));
// The files already carry the name; renaming them is not what is tested.
vi.mock("@/lib/recordings/reconcile-storage", () => ({
    reconcileRecordingStorage: vi.fn(
        async (state: { storagePath: string; storageFilename: string }) => ({
            changed: false,
            storagePath: state.storagePath,
            storageFilename: state.storageFilename,
        }),
    ),
}));
vi.mock("@/lib/auth-server", async () => {
    const { AppError, ErrorCode } =
        await vi.importActual<typeof import("@/lib/errors")>("@/lib/errors");
    return {
        requireApiSession: vi.fn(async (request: Request) => {
            const id = request.headers.get("x-test-user");
            if (!id) {
                throw new AppError(
                    ErrorCode.AUTH_SESSION_MISSING,
                    "Unauthorized",
                    401,
                );
            }
            return { user: { id, email: `${id}@example.test` } };
        }),
    };
});

import { POST as postEraseRoute } from "@/app/api/recordings/[id]/erase/route";
import { DELETE as deleteFolderRoute } from "@/app/api/recordings/[id]/folders/route";
import { PATCH as patchRecordingRoute } from "@/app/api/recordings/[id]/route";
import {
    DELETE as deleteSummaryRoute,
    GET as getSummaryRoute,
    POST as postSummaryRoute,
} from "@/app/api/recordings/[id]/summary/route";
import {
    GET as getTopicsRoute,
    POST as postTopicsRoute,
} from "@/app/api/recordings/[id]/topics/route";
import { GET as getWithdrawPreviewRoute } from "@/app/api/recordings/[id]/withdraw-preview/route";
import { getAiOutputLanguageDirective } from "@/lib/ai/summary-presets";
import { encrypt } from "@/lib/encryption";
import {
    decryptJsonField,
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { readScopeGenerations } from "@/lib/knowledge/scope-generation";
import { ensureOrgAccount } from "@/lib/org/account";
import { reconcileRecordingStorage } from "@/lib/recordings/reconcile-storage";
import { resolveRecordingAccess } from "@/lib/sharing/access";
import { topicsJobHandler } from "@/lib/topics/topics-job-handler";
import { upsertEnhancement } from "@/lib/transcription/persist";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const BOB = "user-bob";
const REC = "rec-one";

type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

function call(
    handler: unknown,
    user: string,
    {
        view,
        method = "GET",
        path = "summary",
        body,
    }: { view?: "org"; method?: string; path?: string; body?: object } = {},
) {
    const url = `http://localhost/api/recordings/${REC}${path ? `/${path}` : ""}${view ? "?view=org" : ""}`;
    return (handler as Handler)(
        new Request(url, {
            method,
            headers: {
                "content-type": "application/json",
                "x-test-user": user,
            },
            ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
        }),
        { params: Promise.resolve({ id: REC }) },
    );
}

describeWithDatabase("a shared recording is one recording (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "one_recording",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await insertRecordings(db(), {
            id: REC,
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/rec.mp3`,
            storageFilename: "rec.mp3",
            plaudVersion: "1",
        });
        // No speakers, so nothing stands in the way of sharing it.
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: OWNER,
                text: encryptText("What was said."),
                provider: "openai",
                model: "whisper-1",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: REC,
                userId: OWNER,
                transcriptionId: transcript?.id,
                summary: encryptText("The owner's summary."),
                provider: "openai",
                model: "gpt",
                source: "riffado",
            });
    });

    async function share() {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: root?.id ?? "",
        });
    }

    async function summaries() {
        return db()
            .select({ userId: aiEnhancements.userId })
            .from(aiEnhancements)
            .where(eq(aiEnhancements.itemId, REC));
    }

    it("shows every member the owner's summary on the Organization view", async () => {
        await share();

        const response = await call(getSummaryRoute, BOB, { view: "org" });

        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body.summary).toBe("The owner's summary.");
        expect(body).not.toHaveProperty("fallback");
    });

    it("lets neither a member nor the owner generate or delete its summary while shared", async () => {
        await share();

        for (const method of ["POST", "DELETE"]) {
            const handler =
                method === "POST" ? postSummaryRoute : deleteSummaryRoute;
            const member = await call(handler, BOB, { view: "org", method });
            expect(member.status).toBe(403);
            const owner = await call(handler, OWNER, { method });
            expect(owner.status).toBe(409);
            await expect(owner.json()).resolves.toMatchObject({
                code: "RECORDING_SHARED",
            });
        }
        expect(await summaries()).toEqual([{ userId: OWNER }]);
    });

    it("lets the organization account delete it, for the owner too", async () => {
        await share();

        const response = await call(deleteSummaryRoute, orgUserId, {
            view: "org",
            method: "DELETE",
        });

        expect(response.status).toBe(200);
        expect(await summaries()).toEqual([]);
    });

    it("gives the owner back what is left after a withdrawal, to change again", async () => {
        await share();
        await unshareRecording(OWNER, REC, { withdraw: true });

        expect(
            (await call(deleteSummaryRoute, orgUserId, { method: "DELETE" }))
                .status,
        ).toBe(404);
        const owner = await call(deleteSummaryRoute, OWNER, {
            method: "DELETE",
        });
        expect(owner.status).toBe(200);
        expect(
            await db()
                .select()
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.itemId, REC),
                        eq(aiEnhancements.userId, OWNER),
                    ),
                ),
        ).toEqual([]);
    });

    it("keeps the title and topics the organization account's while shared", async () => {
        await share();

        const rename = await call(patchRecordingRoute, OWNER, {
            method: "PATCH",
            path: "",
            body: { filename: "Renamed" },
        });
        expect(rename.status).toBe(409);
        await expect(rename.json()).resolves.toMatchObject({
            code: "RECORDING_SHARED",
        });
        const topics = await call(postTopicsRoute, OWNER, {
            method: "POST",
            path: "topics",
        });
        expect(topics.status).toBe(409);
        // An automatic detection queued before the share has nothing to do.
        expect(
            await topicsJobHandler.run({
                payload: {
                    recordingId: REC,
                    source: "riffado",
                    trigger: "auto",
                },
                userId: OWNER,
                reportProgress: () => {},
            } as unknown as Parameters<typeof topicsJobHandler.run>[0]),
        ).toEqual({ skipped: "shared" });

        await unshareRecording(OWNER, REC, { withdraw: true });
        const renamed = await call(patchRecordingRoute, OWNER, {
            method: "PATCH",
            path: "",
            body: { filename: "Renamed" },
        });
        expect(renamed.status).toBe(200);
    });

    it("lets the organization account rename it while shared, in the owner's storage, and the owner keeps the title", async () => {
        await share();
        const rename = (user: string, filename: string, view?: "org") =>
            call(patchRecordingRoute, user, {
                method: "PATCH",
                path: "",
                view,
                body: { filename },
            });

        expect((await rename(BOB, "Bob's", "org")).status).toBe(403);
        expect((await rename(OWNER, "Owner's", "org")).status).toBe(403);
        const curated = await rename(orgUserId, "Curated", "org");
        expect(curated.status).toBe(200);
        await expect(curated.json()).resolves.toEqual({ filename: "Curated" });
        expect(vi.mocked(reconcileRecordingStorage)).toHaveBeenLastCalledWith(
            expect.objectContaining({ userId: OWNER, title: "Curated" }),
        );
        // The private view is still the owner's alone.
        expect((await rename(orgUserId, "Private", undefined)).status).toBe(
            404,
        );

        await unshareRecording(OWNER, REC, { withdraw: true });
        const [row] = await db()
            .select({
                filename: chatterItems.title,
                titleEditedAt: chatterItems.titleEditedAt,
            })
            .from(chatterItems)
            .where(eq(chatterItems.id, REC));
        expect(decryptText(row?.filename ?? "")).toBe("Curated");
        expect(row?.titleEditedAt).not.toBeNull();
        // Withdrawn, the curator's view of it is gone.
        expect((await rename(orgUserId, "Again", "org")).status).toBe(404);
    });

    it("lets the organization account detect topics on the Organization view, with the Organization's settings", async () => {
        const turns = [
            {
                speaker: "speaker_0",
                startMs: 0,
                endMs: 30_000,
                text: "Rozpočet.",
            },
            {
                speaker: "speaker_1",
                startMs: 30_000,
                endMs: 60_000,
                text: "Termíny.",
            },
        ];
        // Shared first: the share gate would ask for these voices' names.
        await share();
        await db()
            .update(transcriptions)
            .set({ turns: encryptJsonField(turns) })
            .where(eq(transcriptions.recordingId, REC));
        for (const [userId, aiOutputLanguage] of [
            [OWNER, "de"],
            [orgUserId, "cs"],
        ] as const) {
            await db()
                .insert(userSettings)
                .values({ userId, aiOutputLanguage })
                .onConflictDoUpdate({
                    target: userSettings.userId,
                    set: { aiOutputLanguage },
                });
        }
        // The organization account pays; the owner has no provider at all.
        await db()
            .insert(apiCredentials)
            .values({
                userId: orgUserId,
                provider: "openai",
                apiKey: encrypt("org-key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });
        const detect = (user: string, view?: "org") =>
            call(postTopicsRoute, user, {
                method: "POST",
                path: "topics",
                view,
            });

        expect((await detect(BOB, "org")).status).toBe(403);
        expect((await detect(OWNER, "org")).status).toBe(403);
        // Anyone the recording is shared with reads them there.
        expect(
            (await call(getTopicsRoute, BOB, { path: "topics", view: "org" }))
                .status,
        ).toBe(200);

        createCompletion.mockResolvedValueOnce({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            topics: [
                                { start: "00:00", title: "Rozpočet" },
                                { start: "00:30", title: "Termíny" },
                            ],
                        }),
                    },
                },
            ],
        });
        const result = await topicsJobHandler.run({
            payload: {
                recordingId: REC,
                source: "riffado",
                trigger: "manual",
                view: "org",
            },
            userId: orgUserId,
            reportProgress: () => {},
        } as unknown as Parameters<typeof topicsJobHandler.run>[0]);

        expect(result).toMatchObject({ topicCount: 2 });
        const [{ messages }] = createCompletion.mock.calls[0] ?? [{}];
        expect(messages[0].content).toContain(
            getAiOutputLanguageDirective("cs"),
        );
        const [row] = await db()
            .select({ topics: transcriptions.topics })
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, REC));
        expect(
            decryptJsonField<{ topics: unknown[] }>(row?.topics)?.topics,
        ).toHaveLength(2);
    });

    it("lets the organization account take it out of the Organization, after seeing the owner's retention warning", async () => {
        await db()
            .insert(userSettings)
            .values({ userId: OWNER, retentionLocalAudioDays: 7 })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: { retentionLocalAudioDays: 7 },
            });
        await share();
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        const preview = (user: string, view?: "org") =>
            call(getWithdrawPreviewRoute, user, {
                path: "withdraw-preview",
                view,
            });
        const remove = (user: string, body: object) =>
            call(deleteFolderRoute, user, {
                method: "DELETE",
                path: "folders",
                body,
            });

        expect((await preview(BOB, "org")).status).toBe(403);
        const seen = await preview(orgUserId, "org");
        expect(seen.status).toBe(200);
        await expect(seen.json()).resolves.toEqual({
            due: [{ kind: "audio", days: 7 }],
        });

        expect((await remove(BOB, { organization: true })).status).toBe(403);
        const unconfirmed = await remove(orgUserId, { folderId: root?.id });
        expect(unconfirmed.status).toBe(409);
        await expect(unconfirmed.json()).resolves.toMatchObject({
            code: "WITHDRAW_UNCONFIRMED",
        });
        const withdrawn = await remove(orgUserId, {
            folderId: root?.id,
            withdraw: true,
        });
        expect(withdrawn.status).toBe(200);
        expect(await resolveRecordingAccess(orgUserId, REC)).toBeNull();

        // And the whole tree at once, shared again: confirmed the same way.
        await share();
        const unconfirmedAll = await remove(orgUserId, { organization: true });
        expect(unconfirmedAll.status).toBe(409);
        await expect(unconfirmedAll.json()).resolves.toMatchObject({
            code: "WITHDRAW_UNCONFIRMED",
        });
        expect(await resolveRecordingAccess(orgUserId, REC)).not.toBeNull();
        expect((await remove(OWNER, { organization: true })).status).toBe(409);
        expect(
            (await remove(orgUserId, { organization: true, withdraw: true }))
                .status,
        ).toBe(200);
        expect(await resolveRecordingAccess(orgUserId, REC)).toBeNull();
    });

    it("answers the organization account's withdrawal of a recording that is not shared as a missing one, changing nothing", async () => {
        const generation = async () =>
            (await readScopeGenerations(db(), [OWNER])).get(OWNER) ?? 0;
        const before = await generation();
        const remove = (user: string) =>
            call(deleteFolderRoute, user, {
                method: "DELETE",
                path: "folders",
                body: { organization: true, withdraw: true },
            });

        expect((await remove(orgUserId)).status).toBe(404);
        // Withdrawn once, then again.
        await share();
        expect((await remove(orgUserId)).status).toBe(200);
        const afterWithdrawal = await generation();
        expect((await remove(orgUserId)).status).toBe(404);
        expect(await generation()).toBe(afterWithdrawal);
        // The owner's own no-op changes nothing either.
        expect((await remove(OWNER)).status).toBe(200);
        expect(await generation()).toBe(afterWithdrawal);
        expect(afterWithdrawal).toBeGreaterThan(before);
    });

    it("erases a shared recording only by taking it out of the Organization first", async () => {
        await share();
        const erase = (body: object) =>
            call(postEraseRoute, OWNER, {
                method: "POST",
                path: "erase",
                body,
            });

        const refused = await erase({ scope: "transcript" });
        expect(refused.status).toBe(409);
        await expect(refused.json()).resolves.toMatchObject({
            code: "RECORDING_SHARED",
        });
        expect(await resolveRecordingAccess(BOB, REC)).not.toBeNull();

        const erased = await erase({ scope: "transcript", withdraw: true });
        expect(erased.status).toBe(200);
        // Withdrawn and erased together: nobody but the owner sees it, and
        // its transcript is gone.
        expect(await resolveRecordingAccess(BOB, REC)).toBeNull();
        expect(
            await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, REC)),
        ).toEqual([]);
    });
    it("lets only the writer of the moment store a summary", async () => {
        const [transcript] = await db()
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, REC));
        const store = (actorUserId: string) =>
            upsertEnhancement({
                userId: OWNER,
                actorUserId,
                recordingId: REC,
                transcriptionId: transcript?.id ?? "",
                summary: `by ${actorUserId}`,
                keyPoints: [],
                actionItems: [],
                source: "riffado",
                provider: "openai",
                model: "gpt",
            });
        await share();

        expect(await store(OWNER)).toEqual({
            committed: false,
            reason: "shared",
        });
        expect(await store(BOB)).toEqual({
            committed: false,
            reason: "shared",
        });
        expect(await store(orgUserId)).toEqual({ committed: true });

        await unshareRecording(OWNER, REC, { withdraw: true });
        expect(await store(orgUserId)).toEqual({
            committed: false,
            reason: "withdrawn",
        });
        expect(await store(OWNER)).toEqual({ committed: true });
    });
});
