/**
 * A transcript's revision counts its versions: every write of its text or
 * turns adds one, and nothing else does. Speaker changes and Learn runs name
 * the revision they were made on, so a stale one can be refused.
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
    recordingFolders,
    transcriptions,
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

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";
import { upsertTranscription } from "@/lib/transcription/persist";
import { storeBrowserTranscription } from "@/lib/transcription/transcribe-recording";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const REC = "rec-meeting";

describeWithDatabase("transcript revision (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "transcript_revision",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db().insert(users).values({ id: ALICE, email: "a@x.test" });
        await insertRecordings(db(), {
            id: REC,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/rec.mp3`,
            plaudVersion: "1",
        });
    });

    function write(text: string) {
        return upsertTranscription({
            userId: ALICE,
            recordingId: REC,
            text,
            detectedLanguage: "en",
            source: "riffado",
            provider: "openai",
            model: "whisper-1",
        });
    }

    async function revisions(userId = ALICE) {
        const rows = await db()
            .select({
                revision: transcriptions.revision,
                source: transcriptions.source,
            })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, REC),
                    eq(transcriptions.userId, userId),
                ),
            );
        return rows.map((row) => row.revision);
    }

    it("starts at 0 and adds one on every overwrite", async () => {
        await write("first");
        expect(await revisions()).toEqual([0]);
        await write("second");
        expect(await revisions()).toEqual([1]);
        await write("second");
        expect(await revisions()).toEqual([2]);
    });

    it("adds one when the browser overwrites the transcript", async () => {
        await write("server");
        const result = await storeBrowserTranscription({
            userId: ALICE,
            recordingId: REC,
            text: "browser",
            detectedLanguage: "en",
            model: "whisper-base",
        });
        expect(result.success).toBe(true);
        expect(await revisions()).toEqual([1]);
    });

    it("is left alone by a topics write", async () => {
        await write("first");
        await db()
            .update(transcriptions)
            .set({ topics: encryptJsonField({ topics: [] }) })
            .where(eq(transcriptions.recordingId, REC));
        expect(await revisions()).toEqual([0]);
    });

    it("counts on through the organization account's rewrites of a shared transcript", async () => {
        await write("first");
        const orgUserId = (await ensureOrgAccount()) ?? "";
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: ALICE,
            recordingId: REC,
            folderId: root?.id ?? "",
        });

        const { committed } = await upsertTranscription({
            userId: ALICE,
            actorUserId: orgUserId,
            recordingId: REC,
            text: "second",
            detectedLanguage: "en",
            source: "riffado",
            provider: "openai",
            model: "whisper-1",
        });

        // One transcript, the owner's, one version further.
        expect(committed).toBe(true);
        expect(await revisions()).toEqual([1]);
        expect(await revisions(orgUserId)).toEqual([]);
    });
    it("drops the summary of the text a forced write replaces, in the same write", async () => {
        await write("first");
        const [transcript] = await db()
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, REC));
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: REC,
                userId: ALICE,
                transcriptionId: transcript?.id,
                summary: encryptText("about the first text"),
                provider: "openai",
                model: "gpt",
                source: "riffado",
            });

        const { committed } = await upsertTranscription({
            userId: ALICE,
            recordingId: REC,
            text: "second",
            detectedLanguage: "en",
            source: "riffado",
            provider: "openai",
            model: "whisper-1",
            dropSummaryOnReplace: "riffado",
        });

        expect(committed).toBe(true);
        expect(
            await db()
                .select()
                .from(aiEnhancements)
                .where(eq(aiEnhancements.itemId, REC)),
        ).toEqual([]);
    });
});
