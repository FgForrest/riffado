/**
 * The first own transcript of a recording is offered the names confirmed on
 * Plaud's, as suggestions, with labels matched by speech overlap or, without
 * timings, by speaking order.
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

import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { copyMatchingSpeakerAttributions } from "@/lib/knowledge/attribution";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const REC = "rec-meeting";

const turn = (
    speaker: string,
    startMs: number,
    endMs: number,
): TranscriptTurn => ({ speaker, startMs, endMs, text: `${speaker} talking` });

function textOf(turns: TranscriptTurn[]): string {
    return turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
}

describeWithDatabase(
    "names offered from the other transcript (PostgreSQL)",
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
                "attribution_copy",
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

        async function transcript(
            source: "plaud" | "riffado",
            content: { turns?: TranscriptTurn[]; text?: string },
        ): Promise<string> {
            const [row] = await db()
                .insert(transcriptions)
                .values({
                    recordingId: REC,
                    userId: ALICE,
                    text: encryptText(
                        content.text ?? textOf(content.turns ?? []),
                    ),
                    turns: content.turns
                        ? encryptJsonField(content.turns)
                        : null,
                    provider: source === "plaud" ? "plaud" : "openai",
                    model:
                        source === "plaud"
                            ? "plaud"
                            : "gpt-4o-transcribe-diarize",
                    source,
                })
                .returning({ id: transcriptions.id });
            return row?.id ?? "";
        }

        async function confirm(
            transcriptionId: string,
            label: string,
            personId: string | null,
            markedUnknown = false,
        ) {
            await db().insert(transcriptSpeakers).values({
                userId: ALICE,
                transcriptionId,
                label,
                personId,
                source: "user",
                status: "confirmed",
                markedUnknown,
                confirmedByUserId: ALICE,
            });
        }

        async function speakersOf(transcriptionId: string) {
            const rows = await db()
                .select({
                    label: transcriptSpeakers.label,
                    personId: transcriptSpeakers.personId,
                    status: transcriptSpeakers.status,
                    source: transcriptSpeakers.source,
                    confirmedByUserId: transcriptSpeakers.confirmedByUserId,
                })
                .from(transcriptSpeakers)
                .where(eq(transcriptSpeakers.transcriptionId, transcriptionId));
            return rows.sort((a, b) => a.label.localeCompare(b.label));
        }

        function copy() {
            return copyMatchingSpeakerAttributions({
                userId: ALICE,
                recordingId: REC,
                sourceSource: "plaud",
                targetSource: "riffado",
                writer: { actorUserId: ALICE, orgUserId: null },
            });
        }

        it("matches labels by speech overlap, and offers them as suggestions", async () => {
            const plaud = await transcript("plaud", {
                turns: [
                    turn("Speaker 1", 0, 10_000),
                    turn("Speaker 2", 10_000, 20_000),
                ],
            });
            await confirm(plaud, "Speaker 1", jana);
            await confirm(plaud, "Speaker 2", petr);
            const own = await transcript("riffado", {
                turns: [
                    turn("speaker_1", 200, 9_900),
                    turn("speaker_0", 10_100, 20_000),
                ],
            });

            expect(await copy()).toBe(2);
            const suggestion = {
                status: "suggested",
                source: "heuristic",
                confirmedByUserId: null,
            };
            expect(await speakersOf(own)).toEqual([
                { label: "speaker_0", personId: petr, ...suggestion },
                { label: "speaker_1", personId: jana, ...suggestion },
            ]);
        });

        it("matches by speaking order when there are no timings", async () => {
            const plaud = await transcript("plaud", {
                text: "Speaker 1: Hello\nSpeaker 2: Hi\nSpeaker 1: Bye",
            });
            await confirm(plaud, "Speaker 1", jana);
            const own = await transcript("riffado", {
                text: "speaker_0: Hello\nspeaker_1: Hi\nspeaker_0: Bye",
            });

            expect(await copy()).toBe(1);
            expect(await speakersOf(own)).toEqual([
                expect.objectContaining({
                    label: "speaker_0",
                    personId: jana,
                    status: "suggested",
                }),
            ]);
        });

        it("offers nothing for an unknown speaker", async () => {
            const plaud = await transcript("plaud", {
                turns: [turn("Speaker 1", 0, 10_000)],
            });
            await confirm(plaud, "Speaker 1", null, true);
            const own = await transcript("riffado", {
                turns: [turn("speaker_0", 0, 10_000)],
            });

            expect(await copy()).toBe(0);
            expect(await speakersOf(own)).toEqual([]);
        });

        it("skips a pair rejected on the target, and never overwrites an answer", async () => {
            const plaud = await transcript("plaud", {
                turns: [
                    turn("Speaker 1", 0, 10_000),
                    turn("Speaker 2", 10_000, 20_000),
                ],
            });
            await confirm(plaud, "Speaker 1", jana);
            await confirm(plaud, "Speaker 2", petr);
            const own = await transcript("riffado", {
                turns: [
                    turn("speaker_0", 0, 10_000),
                    turn("speaker_1", 10_000, 20_000),
                ],
            });
            await db().insert(transcriptSpeakerRejections).values({
                userId: ALICE,
                transcriptionId: own,
                label: "speaker_0",
                personId: jana,
            });
            await confirm(own, "speaker_1", null, true);

            expect(await copy()).toBe(0);
            expect(await speakersOf(own)).toEqual([
                expect.objectContaining({
                    label: "speaker_1",
                    personId: null,
                    status: "confirmed",
                }),
            ]);
        });
    },
);
