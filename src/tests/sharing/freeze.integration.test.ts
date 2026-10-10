/**
 * While shared, only the organization account changes a recording, checked
 * where its data is written, against a real PostgreSQL.
 *
 * The routes refuse early, but a run queued or started before a share or a
 * withdrawal reaches the writer after it: the provider job, a transcript
 * made in the browser, a Plaud import. The owner's must write nothing once
 * shared, and an automatic job must end as skipped, not failed; the
 * organization account's must write nothing once withdrawn.
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
    apiCredentials,
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

const { dbProxy, dbRef, mockEnv, provider } = vi.hoisted(() => {
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
        provider: {
            calls: 0,
            // Run once, while the provider is transcribing.
            during: null as null | (() => Promise<void>),
            // What it answers, when not the default text.
            result: null as null | {
                text: string;
                detectedLanguage: string;
                turns?: {
                    speaker: string;
                    startMs: number;
                    endMs: number;
                    text: string;
                }[];
            },
        },
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test" as string | undefined,
            ORG_ACCOUNT_PASSWORD: "organization-password" as string | undefined,
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            WHISPER_REQUEST_TIMEOUT_MS: 60_000,
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
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("audio-bytes")),
    }),
}));
vi.mock("@/lib/transcription/elevenlabs-transcribe", () => ({
    // No Almanac names: these runs are about what a share freezes.
    elevenLabsTakesKeyterms: () => false,
    elevenLabsTranscribe: vi.fn(async () => {
        provider.calls += 1;
        const run = provider.during;
        provider.during = null;
        await run?.();
        return (
            provider.result ?? {
                text: "A new transcript.",
                detectedLanguage: "en",
            }
        );
    }),
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

import { POST as postBrowserTranscript } from "@/app/api/recordings/[id]/transcription/from-browser/route";
import { encrypt } from "@/lib/encryption";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { addRecordingToFolder } from "@/lib/folders/folders";
import { copyMatchingSpeakerAttributions } from "@/lib/knowledge/attribution";
import { ensureOrgAccount } from "@/lib/org/account";
import { upsertTranscription } from "@/lib/transcription/persist";
import { transcriptionJobHandler } from "@/lib/transcription/transcription-job-handler";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const BOB = "user-bob";
const REC = "rec-frozen";
const SHARED_TEXT = "What was shared.";

type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

describeWithDatabase(
    "only the organization account changes a shared recording (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;
        let orgUserId = "";

        function db() {
            if (!database) throw new Error("test database was not initialized");
            return database.db;
        }

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "frozen",
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
            provider.calls = 0;
            provider.during = null;
            provider.result = null;
            mockEnv.ORG_ACCOUNT_EMAIL = "org@example.test";
            mockEnv.ORG_ACCOUNT_PASSWORD = "organization-password";
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
                plaudVersion: "1",
            });
            // Transcribed without speakers, so nothing stands in the way of
            // sharing it.
            await db()
                .insert(transcriptions)
                .values({
                    recordingId: REC,
                    userId: OWNER,
                    text: encryptText(SHARED_TEXT),
                    provider: "openai",
                    model: "whisper-1",
                    source: "riffado",
                });
            for (const userId of [OWNER, BOB, orgUserId]) {
                await db()
                    .insert(apiCredentials)
                    .values({
                        userId,
                        provider: "ElevenLabs",
                        apiKey: encrypt("test-key"),
                        defaultModel: "scribe_v1",
                        isDefaultTranscription: true,
                    });
                await db()
                    .insert(userSettings)
                    .values({ userId, autoGenerateTitle: false })
                    // The organization account has its settings already.
                    .onConflictDoNothing();
            }
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

        async function textOf(userId: string, source = "riffado") {
            const [row] = await db()
                .select({ text: transcriptions.text })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, REC),
                        eq(transcriptions.userId, userId),
                        eq(transcriptions.source, source),
                    ),
                );
            return row ? decryptText(row.text) : null;
        }

        function runJob(
            userId: string,
            view: "private" | "org",
            trigger: "manual" | "sync" = "sync",
        ): ReturnType<typeof transcriptionJobHandler.run> {
            return transcriptionJobHandler.run({
                payload: {
                    recordingId: REC,
                    trigger,
                    force: true,
                    view,
                },
                userId,
            } as Parameters<typeof transcriptionJobHandler.run>[0]);
        }

        async function refusal(promise: Promise<unknown>) {
            const error = await promise.then(
                () => null,
                (caught: unknown) => caught,
            );
            expect(error).toMatchObject({
                statusCode: 409,
                code: "RECORDING_SHARED",
            });
            return error as Error;
        }

        it("lets a provider run that began before the share write nothing after it, and skips its job", async () => {
            provider.during = share;

            expect(await runJob(OWNER, "private")).toEqual({
                skipped: "shared",
            });

            expect(provider.calls).toBe(1);
            expect(await textOf(OWNER)).toBe(SHARED_TEXT);
        });

        it("never pays a provider for a run queued before the share and started after it", async () => {
            await share();

            expect(await runJob(OWNER, "private")).toEqual({
                skipped: "shared",
            });
            expect(provider.calls).toBe(0);
        });

        it("tells whoever asked for the run why it was refused", async () => {
            await share();

            const error = await refusal(runJob(OWNER, "private", "manual"));
            expect(error.message).toContain("shared with the Organization");
            expect(provider.calls).toBe(0);
        });

        it("refuses a member's Organization run where it executes", async () => {
            await share();

            await refusal(runJob(BOB, "org", "manual"));
            expect(provider.calls).toBe(0);
            expect(await textOf(OWNER)).toBe(SHARED_TEXT);
        });

        it("refuses the organization account's run while the Organization is read-only", async () => {
            await share();
            mockEnv.ORG_ACCOUNT_EMAIL = undefined;
            mockEnv.ORG_ACCOUNT_PASSWORD = undefined;

            const error = await refusal(runJob(orgUserId, "org", "manual"));
            expect(error.message).toContain("read-only");
            expect(provider.calls).toBe(0);
            expect(await textOf(OWNER)).toBe(SHARED_TEXT);
        });

        it("lets the organization account re-transcribe the owner's transcript, carrying the names", async () => {
            // A diarized transcript the owner named, then shared.
            const turns = [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 10_000,
                    text: "Hi.",
                },
                {
                    speaker: "speaker_1",
                    startMs: 10_000,
                    endMs: 20_000,
                    text: "Yo.",
                },
            ];
            const [owned] = await db()
                .update(transcriptions)
                .set({
                    text: encryptText("speaker_0: Hi.\nspeaker_1: Yo."),
                    turns: encryptJsonField(turns),
                    model: "scribe_v1",
                    provider: "ElevenLabs",
                })
                .where(eq(transcriptions.userId, OWNER))
                .returning({ id: transcriptions.id });
            const [jana] = await db()
                .insert(people)
                .values({ userId: OWNER, displayName: encryptText("Jana") })
                .returning({ id: people.id });
            await db()
                .insert(transcriptSpeakers)
                .values([
                    {
                        userId: OWNER,
                        transcriptionId: owned?.id ?? "",
                        label: "speaker_0",
                        personId: jana?.id,
                        source: "user",
                        status: "confirmed",
                        confirmedByUserId: OWNER,
                    },
                    {
                        userId: OWNER,
                        transcriptionId: owned?.id ?? "",
                        label: "speaker_1",
                        source: "user",
                        status: "confirmed",
                        markedUnknown: true,
                        confirmedByUserId: OWNER,
                    },
                ]);
            await share();
            // The provider hears the same two voices, numbered the other way.
            provider.result = {
                text: "speaker_1: Hi.\nspeaker_0: Yo.",
                detectedLanguage: "en",
                turns: [
                    {
                        speaker: "speaker_1",
                        startMs: 0,
                        endMs: 10_000,
                        text: "Hi.",
                    },
                    {
                        speaker: "speaker_0",
                        startMs: 10_000,
                        endMs: 20_000,
                        text: "Yo.",
                    },
                ],
            };

            expect(await runJob(orgUserId, "org", "manual")).toEqual({
                transcribed: true,
            });

            // One recording: the owner's row, rewritten, and no other.
            const rows = await db()
                .select({
                    id: transcriptions.id,
                    userId: transcriptions.userId,
                    producedByUserId: transcriptions.producedByUserId,
                    revision: transcriptions.revision,
                })
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, REC));
            expect(rows).toEqual([
                {
                    id: owned?.id,
                    userId: OWNER,
                    producedByUserId: orgUserId,
                    revision: 1,
                },
            ]);
            expect(await textOf(OWNER)).toBe("speaker_1: Hi.\nspeaker_0: Yo.");
            const names = await db()
                .select({
                    label: transcriptSpeakers.label,
                    personId: transcriptSpeakers.personId,
                    markedUnknown: transcriptSpeakers.markedUnknown,
                })
                .from(transcriptSpeakers)
                .where(eq(transcriptSpeakers.transcriptionId, owned?.id ?? ""))
                .orderBy(transcriptSpeakers.label);
            expect(names).toEqual([
                { label: "speaker_0", personId: null, markedUnknown: true },
                {
                    label: "speaker_1",
                    personId: jana?.id,
                    markedUnknown: false,
                },
            ]);
            // Jana was named on a shared recording: the Organization's now.
            const [promoted] = await db()
                .select({ userId: people.userId })
                .from(people)
                .where(eq(people.id, jana?.id ?? ""));
            expect(promoted?.userId).toBe(orgUserId);
        });

        it("lets an organization account's run that outlives the withdrawal write nothing", async () => {
            await share();
            const { unshareRecording } = await import("@/lib/folders/folders");
            provider.during = () =>
                unshareRecording(OWNER, REC, { withdraw: true });

            const error = await runJob(orgUserId, "org", "manual").then(
                () => null,
                (caught: unknown) => caught,
            );

            expect(error).toMatchObject({
                statusCode: 404,
                code: "RECORDING_NOT_FOUND",
            });
            expect(provider.calls).toBe(1);
            expect(await textOf(OWNER)).toBe(SHARED_TEXT);
        });

        it("writes nothing for an organization account's run cancelled by a withdrawal, even once shared again", async () => {
            await share();
            const [job] = await db()
                .insert(asyncJobs)
                .values({
                    userId: orgUserId,
                    kind: "transcription",
                    subjectId: `org:${REC}`,
                    status: "processing",
                    payload: { recordingId: REC, view: "org" },
                })
                .returning({ id: asyncJobs.id });
            const { unshareRecording } = await import("@/lib/folders/folders");
            // Withdrawn and shared again while the provider ran.
            provider.during = async () => {
                await unshareRecording(OWNER, REC, { withdraw: true });
                await share();
            };

            const error = await transcriptionJobHandler
                .run({
                    payload: {
                        recordingId: REC,
                        trigger: "manual",
                        force: true,
                        view: "org",
                    },
                    userId: orgUserId,
                    jobId: job?.id,
                } as Parameters<typeof transcriptionJobHandler.run>[0])
                .then(
                    () => null,
                    (caught: unknown) => caught,
                );

            expect(error).toMatchObject({ statusCode: 404 });
            expect(provider.calls).toBe(1);
            expect(await textOf(OWNER)).toBe(SHARED_TEXT);
        });

        it("refuses a transcript made in the browser once the recording is shared", async () => {
            await share();

            const response = await (
                postBrowserTranscript as unknown as Handler
            )(
                new Request(
                    `http://localhost/api/recordings/${REC}/transcription/from-browser`,
                    {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            "x-test-user": OWNER,
                        },
                        body: JSON.stringify({
                            text: "Made in the browser.",
                            model: "whisper-base",
                        }),
                    },
                ),
                { params: Promise.resolve({ id: REC }) },
            );

            expect(response.status).toBe(409);
            await expect(response.json()).resolves.toMatchObject({
                code: "RECORDING_SHARED",
            });
            expect(await textOf(OWNER)).toBe(SHARED_TEXT);
        });

        it("refuses a Plaud import while the recording is shared, and takes it once withdrawn", async () => {
            await share();
            const plaudImport = () =>
                upsertTranscription({
                    userId: OWNER,
                    recordingId: REC,
                    text: "From Plaud.",
                    detectedLanguage: "en",
                    source: "plaud",
                    provider: "plaud",
                    model: "plaud-native",
                });

            expect(await plaudImport()).toEqual({
                committed: false,
                reason: "shared",
            });
            expect(await textOf(OWNER, "plaud")).toBeNull();

            const { unshareRecording } = await import("@/lib/folders/folders");
            await unshareRecording(OWNER, REC, { withdraw: true });
            expect(await plaudImport()).toEqual({ committed: true });
            expect(await textOf(OWNER, "plaud")).toBe("From Plaud.");
        });

        it("offers no Plaud names on the owner's transcript once it is shared", async () => {
            const turns = [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 10_000,
                    text: "Hi.",
                },
            ];
            await db()
                .update(transcriptions)
                .set({
                    text: encryptText("speaker_0: Hi."),
                    turns: encryptJsonField(turns),
                    model: "scribe_v1",
                })
                .where(eq(transcriptions.userId, OWNER));
            const [plaud] = await db()
                .insert(transcriptions)
                .values({
                    recordingId: REC,
                    userId: OWNER,
                    text: encryptText("speaker_0: Hi."),
                    turns: encryptJsonField(turns),
                    provider: "plaud",
                    model: "plaud-native",
                    source: "plaud",
                })
                .returning({ id: transcriptions.id });
            const [jana] = await db()
                .insert(people)
                .values({ userId: OWNER, displayName: encryptText("Jana") })
                .returning({ id: people.id });
            await db()
                .insert(transcriptSpeakers)
                .values({
                    userId: OWNER,
                    transcriptionId: plaud?.id ?? "",
                    label: "speaker_0",
                    personId: jana?.id,
                    source: "user",
                    status: "confirmed",
                    confirmedByUserId: OWNER,
                });
            const offer = () =>
                copyMatchingSpeakerAttributions({
                    userId: OWNER,
                    recordingId: REC,
                    sourceSource: "plaud",
                    targetSource: "riffado",
                    writer: { actorUserId: OWNER, orgUserId },
                });
            // Shared as it was before the gate, with a speaker nobody named.
            const [root] = await db()
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, orgUserId));
            await db()
                .insert(recordingFolderAssignments)
                .values({
                    userId: OWNER,
                    itemId: REC,
                    folderId: root?.id ?? "",
                });

            expect(await offer()).toBe(0);
            const offered = await db()
                .select()
                .from(transcriptSpeakers)
                .where(eq(transcriptSpeakers.status, "suggested"));
            expect(offered).toEqual([]);

            // Withdrawn, the recording is the owner's to change again.
            const { unshareRecording } = await import("@/lib/folders/folders");
            await unshareRecording(OWNER, REC, { withdraw: true });
            expect(await offer()).toBe(1);
        });
    },
);
