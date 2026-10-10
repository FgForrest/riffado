/**
 * Every write of a transcript moves its speaker names onto the new text by
 * speech overlap, in the same transaction (`remapTranscriptAttributionsInTx`).
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq } from "drizzle-orm";
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
    transcriptions,
    transcriptSpeakerRejections,
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

import { encryptText } from "@/lib/encryption/fields";
import { upsertTranscription } from "@/lib/transcription/persist";
import { storeBrowserTranscription } from "@/lib/transcription/transcribe-recording";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const REC = "rec-meeting";
const DIARIZED = "gpt-4o-transcribe-diarize";

const turn = (
    speaker: string,
    startMs: number,
    endMs: number,
): TranscriptTurn => ({
    speaker,
    startMs,
    endMs,
    text: `${speaker} talking`,
});

function textOf(turns: TranscriptTurn[]): string {
    return turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
}

describeWithDatabase(
    "speaker names follow every transcript write (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;
        let jana = "";
        let petr = "";

        function db() {
            if (!database) throw new Error("test database was not initialized");
            return database.db;
        }

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "attribution_remap",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
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
                duration: 100_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:01:40Z"),
                filesize: 11,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${ALICE}/rec.mp3`,
                plaudVersion: "1",
            });
            const inserted = await db()
                .insert(people)
                .values([
                    { userId: ALICE, displayName: encryptText("Jana") },
                    { userId: ALICE, displayName: encryptText("Petr") },
                ])
                .returning({ id: people.id });
            jana = inserted[0]?.id ?? "";
            petr = inserted[1]?.id ?? "";
        });

        function write(turns: TranscriptTurn[] | undefined, text?: string) {
            return upsertTranscription({
                userId: ALICE,
                recordingId: REC,
                text: text ?? textOf(turns ?? []),
                detectedLanguage: "en",
                source: "riffado",
                provider: "openai",
                model: DIARIZED,
                turns,
            });
        }

        async function transcriptId(): Promise<string> {
            const [row] = await db()
                .select({ id: transcriptions.id })
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, REC));
            return row?.id ?? "";
        }

        async function confirm(
            label: string,
            personId: string | null,
            markedUnknown = false,
        ) {
            await db()
                .insert(transcriptSpeakers)
                .values({
                    userId: ALICE,
                    transcriptionId: await transcriptId(),
                    label,
                    personId,
                    source: "user",
                    status: "confirmed",
                    markedUnknown,
                    confirmedByUserId: ALICE,
                    evidenceStartMs: 1_000,
                });
        }

        async function speakers() {
            const rows = await db()
                .select({
                    label: transcriptSpeakers.label,
                    personId: transcriptSpeakers.personId,
                    status: transcriptSpeakers.status,
                    source: transcriptSpeakers.source,
                    markedUnknown: transcriptSpeakers.markedUnknown,
                    confirmedByUserId: transcriptSpeakers.confirmedByUserId,
                    evidenceStartMs: transcriptSpeakers.evidenceStartMs,
                })
                .from(transcriptSpeakers)
                .where(
                    eq(
                        transcriptSpeakers.transcriptionId,
                        await transcriptId(),
                    ),
                );
            return rows.sort((a, b) => a.label.localeCompare(b.label));
        }

        async function rejections() {
            return db()
                .select({
                    label: transcriptSpeakerRejections.label,
                    personId: transcriptSpeakerRejections.personId,
                })
                .from(transcriptSpeakerRejections)
                .where(
                    eq(
                        transcriptSpeakerRejections.transcriptionId,
                        await transcriptId(),
                    ),
                );
        }

        it("keeps confirmed names when the new run numbers the same voices differently", async () => {
            await write([
                turn("speaker_0", 0, 10_000),
                turn("speaker_1", 10_000, 20_000),
            ]);
            await confirm("speaker_0", jana);
            await confirm("speaker_1", null, true);

            await write([
                turn("speaker_1", 300, 9_800),
                turn("speaker_0", 10_200, 20_000),
            ]);

            expect(await speakers()).toEqual([
                {
                    label: "speaker_0",
                    personId: null,
                    status: "confirmed",
                    source: "user",
                    markedUnknown: true,
                    confirmedByUserId: ALICE,
                    evidenceStartMs: null,
                },
                {
                    label: "speaker_1",
                    personId: jana,
                    status: "confirmed",
                    source: "user",
                    markedUnknown: false,
                    confirmedByUserId: ALICE,
                    evidenceStartMs: null,
                },
            ]);
        });

        it("only suggests a name when two voices merge 70/30", async () => {
            await write([turn("A", 0, 30_000), turn("B", 30_000, 100_000)]);
            await confirm("A", jana);
            await confirm("B", petr);

            await write([turn("X", 0, 100_000)]);

            expect(await speakers()).toEqual([
                expect.objectContaining({
                    label: "X",
                    personId: petr,
                    status: "suggested",
                    source: "heuristic",
                    confirmedByUserId: null,
                }),
            ]);
        });

        it("suggests names by speaking order on a transcript without timings", async () => {
            await write(
                undefined,
                "speaker_0: Hello\nspeaker_1: Hi\nspeaker_0: Bye",
            );
            await confirm("speaker_0", jana);
            await confirm("speaker_1", petr);

            await write(undefined, "A: Hello\nB: Hi\nA: Bye");

            expect(await speakers()).toEqual([
                expect.objectContaining({
                    label: "A",
                    personId: jana,
                    status: "suggested",
                }),
                expect.objectContaining({
                    label: "B",
                    personId: petr,
                    status: "suggested",
                }),
            ]);
        });

        it("drops every name when the browser writes a transcript without speakers", async () => {
            await write([
                turn("speaker_0", 0, 10_000),
                turn("speaker_1", 10_000, 20_000),
            ]);
            await confirm("speaker_0", jana);
            await db()
                .insert(transcriptSpeakerRejections)
                .values({
                    userId: ALICE,
                    transcriptionId: await transcriptId(),
                    label: "speaker_1",
                    personId: jana,
                });

            const result = await storeBrowserTranscription({
                userId: ALICE,
                recordingId: REC,
                text: "Everyone talking at once.",
                detectedLanguage: "en",
                model: "whisper-base",
            });

            expect(result.success).toBe(true);
            expect(await speakers()).toEqual([]);
            expect(await rejections()).toEqual([]);
        });

        it("moves rejections with a clean match and drops them on an uncertain one", async () => {
            await write([
                turn("A", 0, 30_000),
                turn("B", 30_000, 60_000),
                turn("C", 60_000, 100_000),
            ]);
            const id = await transcriptId();
            await db()
                .insert(transcriptSpeakerRejections)
                .values([
                    {
                        userId: ALICE,
                        transcriptionId: id,
                        label: "A",
                        personId: jana,
                    },
                    {
                        userId: ALICE,
                        transcriptionId: id,
                        label: "B",
                        personId: petr,
                    },
                ]);

            // A is renumbered cleanly; B and C merge into one voice.
            await write([turn("Z", 0, 30_000), turn("Y", 30_000, 100_000)]);

            expect(await rejections()).toEqual([
                { label: "Z", personId: jana },
            ]);
        });

        it("never suggests a pair a moved rejection rules out", async () => {
            await write([turn("A", 0, 30_000), turn("B", 30_000, 60_000)]);
            const id = await transcriptId();
            await db().insert(transcriptSpeakers).values({
                userId: ALICE,
                transcriptionId: id,
                label: "A",
                personId: jana,
                source: "llm",
                status: "suggested",
            });
            await db().insert(transcriptSpeakerRejections).values({
                userId: ALICE,
                transcriptionId: id,
                label: "A",
                personId: jana,
            });

            await write([turn("X", 0, 30_000), turn("Y", 30_000, 60_000)]);

            expect(await speakers()).toEqual([]);
            expect(await rejections()).toEqual([
                { label: "X", personId: jana },
            ]);
        });
    },
);
