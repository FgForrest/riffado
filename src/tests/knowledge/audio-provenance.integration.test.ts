/**
 * Audio provenance on transcripts (follow-up of review 3): a transcript
 * keeps the md5 of the audio it was made from, and a rewrite over other
 * audio (a Plaud recording trimmed and synced again) carries names only as
 * suggestions, since the timeline shifted.
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
    people,
    recordings,
    transcriptions,
    transcriptSpeakers,
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
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/ai/generate-title", () => ({
    generateTitleFromTranscription: vi.fn().mockResolvedValue("Held title"),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
}));

import { encryptText } from "@/lib/encryption/fields";
import { audioReplacedInTx } from "@/lib/knowledge/transcript-rewrite";
import { ensureOrgAccount } from "@/lib/org/account";
import { upsertTranscription } from "@/lib/transcription/persist";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const REC = "rec-audio";
const TURNS = [
    { speaker: "speaker_0", startMs: 0, endMs: 5_000, text: "Ahoj." },
    { speaker: "speaker_1", startMs: 5_000, endMs: 9_000, text: "Čau." },
];

describeWithDatabase("audio provenance on transcripts (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "audio_provenance",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    const write = () =>
        upsertTranscription({
            userId: OWNER,
            recordingId: REC,
            text: "Ahoj. Čau.",
            detectedLanguage: "cs",
            source: "plaud",
            provider: "plaud",
            model: "plaud",
            turns: TURNS,
        });

    beforeEach(async () => {
        await db().delete(users);
        await db().insert(users).values({ id: OWNER, email: "o@example.test" });
        await ensureOrgAccount();
        await insertRecordings(db(), {
            id: REC,
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 9_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:09Z"),
            filesize: 11,
            fileMd5: "a".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/rec.mp3`,
            plaudVersion: "1",
        });
        await write();
        const [transcript] = await db()
            .select({ id: transcriptions.id })
            .from(transcriptions);
        const [ana] = await db()
            .insert(people)
            .values({ userId: OWNER, displayName: encryptText("Ana Nováková") })
            .returning({ id: people.id });
        await db()
            .insert(transcriptSpeakers)
            .values({
                userId: OWNER,
                transcriptionId: transcript?.id ?? "",
                label: "speaker_0",
                personId: ana?.id ?? null,
                source: "user",
                status: "confirmed",
                markedUnknown: false,
                confirmedByUserId: OWNER,
            });
    });

    const speaker0 = async () =>
        (
            await db()
                .select({ status: transcriptSpeakers.status })
                .from(transcriptSpeakers)
                .where(and(eq(transcriptSpeakers.label, "speaker_0")))
        )[0]?.status;

    it("keeps the audio a transcript was made from", async () => {
        const [transcript] = await db()
            .select({ audioMd5: transcriptions.audioMd5 })
            .from(transcriptions);
        expect(transcript?.audioMd5).toBe("a".repeat(32));
    });

    it("carries a confirmed answer over the same audio, and only suggests it over other audio", async () => {
        await write();
        expect(await speaker0()).toBe("confirmed");

        // Trimmed in the Plaud app and synced again.
        await db()
            .update(recordings)
            .set({ fileMd5: "b".repeat(32) })
            .where(eq(recordings.id, REC));
        await write();

        // Not the same voice for certain any more: offered, not kept.
        expect(await speaker0()).toBe("suggested");
        const [transcript] = await db()
            .select({ audioMd5: transcriptions.audioMd5 })
            .from(transcriptions);
        expect(transcript?.audioMd5).toBe("b".repeat(32));
    });

    it("demotes the names on a transcript whose audio a sync replaced and kept it", async () => {
        await db().transaction(async (tx) => {
            await tx
                .update(recordings)
                .set({ fileMd5: "b".repeat(32) })
                .where(eq(recordings.id, REC));
            await audioReplacedInTx(tx, REC, {
                from: "a".repeat(32),
                to: "b".repeat(32),
            });
        });

        expect(await speaker0()).toBe("suggested");
        // Still made from the old audio: a later rewrite sees the change too.
        const [transcript] = await db()
            .select({ audioMd5: transcriptions.audioMd5 })
            .from(transcriptions);
        expect(transcript?.audioMd5).toBe("a".repeat(32));
    });

    it("keeps the names confirmed after a trim when a later sync brings the same audio", async () => {
        const trimmed = { from: "a".repeat(32), to: "b".repeat(32) };
        await db().transaction((tx) => audioReplacedInTx(tx, REC, trimmed));
        // The person confirms the speaker again on the kept transcript.
        await db()
            .update(transcriptSpeakers)
            .set({ status: "confirmed" })
            .where(eq(transcriptSpeakers.label, "speaker_0"));

        // Renamed in the Plaud app: a new version, the same audio.
        const renamed = { from: "b".repeat(32), to: "b".repeat(32) };
        await db().transaction((tx) => audioReplacedInTx(tx, REC, renamed));

        expect(await speaker0()).toBe("confirmed");
    });

    it("does not claim to know the audio when a sync replaced it while transcribing", async () => {
        await db()
            .update(recordings)
            .set({ fileMd5: "b".repeat(32) })
            .where(eq(recordings.id, REC));
        // Began on audio "a"; the trim landed before it finished.
        await upsertTranscription({
            userId: OWNER,
            recordingId: REC,
            text: "Ahoj. Čau.",
            detectedLanguage: "cs",
            source: "plaud",
            provider: "plaud",
            model: "plaud",
            turns: TURNS,
            audioMd5: "a".repeat(32),
        });

        // Made from "a" or from "b": nobody can say, so the names are
        // offered again rather than kept.
        expect(await speaker0()).toBe("suggested");
        // It keeps "a", unlike the recording: a later change still counts.
        const [transcript] = await db()
            .select({ audioMd5: transcriptions.audioMd5 })
            .from(transcriptions);
        expect(transcript?.audioMd5).toBe("a".repeat(32));

        // Confirmed again, then trimmed once more in Plaud.
        await db()
            .update(transcriptSpeakers)
            .set({ status: "confirmed" })
            .where(eq(transcriptSpeakers.label, "speaker_0"));
        await db().transaction((tx) =>
            audioReplacedInTx(tx, REC, {
                from: "b".repeat(32),
                to: "c".repeat(32),
            }),
        );
        expect(await speaker0()).toBe("suggested");
    });

    it("stamps the audio a transcription began on when it is still there", async () => {
        await upsertTranscription({
            userId: OWNER,
            recordingId: REC,
            text: "Ahoj. Čau.",
            detectedLanguage: "cs",
            source: "plaud",
            provider: "plaud",
            model: "plaud",
            turns: TURNS,
            audioMd5: "a".repeat(32),
        });

        expect(await speaker0()).toBe("confirmed");
        const [transcript] = await db()
            .select({ audioMd5: transcriptions.audioMd5 })
            .from(transcriptions);
        expect(transcript?.audioMd5).toBe("a".repeat(32));
    });
});
