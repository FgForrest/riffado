/**
 * The correction pass against a real PostgreSQL: queued by a finished
 * review (or a Learn run that found nothing), holding back what automatic
 * Learn held until it ends, writing its fixes as corrections, and going
 * nowhere on a transcript changed since.
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
    chatterItems,
    learnRuns,
    transcriptCorrectionPasses,
    transcriptCorrections,
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
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20,
            KNOWLEDGE_MEMORY_MB: 64,
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

import { encrypt } from "@/lib/encryption";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { listCorrections } from "@/lib/knowledge/corrections";
import { createEntity } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { AUTO_LEARN_HOLD_MS } from "@/lib/learn/auto-learn";
import { correctionPassJobHandler } from "@/lib/learn/correction-pass-job";
import { LEARN_CORRECT_JOB_KIND } from "@/lib/learn/correction-pass-queue";
import { learnJobHandler } from "@/lib/learn/learn-job-handler";
import { finishReview } from "@/lib/learn/review";
import { ensureOrgAccount } from "@/lib/org/account";
import { requireRecordingView } from "@/lib/sharing/access";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const REC = "rec-correct";
const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 5_000,
        text: "Projekt Oryon běží a sklat je plný.",
    },
    {
        speaker: "speaker_1",
        startMs: 5_000,
        endMs: 9_000,
        text: "Oryon dodáme v pátek.",
    },
];

function reply(content: unknown) {
    return {
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
}

describeWithDatabase("The correction pass (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let transcriptId = "";
    let orion = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "correction_pass",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        createCompletion.mockReset();
        knowledgeStore().invalidateAll();
        await db().delete(asyncJobs);
        await db().delete(users);
        await db().insert(users).values({ id: OWNER, email: "o@example.test" });
        await ensureOrgAccount();
        await seedCoreVocabulary();
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
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/rec.mp3`,
            plaudVersion: "1",
            summaryDueAt: new Date(Date.now() + AUTO_LEARN_HOLD_MS),
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: OWNER,
                text: encryptText(TURNS.map((turn) => turn.text).join("\n")),
                turns: encryptJsonField(TURNS),
                detectedLanguage: "cs",
                provider: "ElevenLabs",
                model: "scribe_v2+diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        transcriptId = transcript?.id ?? "";
        await db()
            .insert(apiCredentials)
            .values({
                userId: OWNER,
                provider: "openai",
                apiKey: encrypt("key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });
        orion = (
            await createEntity(OWNER, { typeKey: "project", name: "Orion" })
        ).id;
    });

    const readyRun = () =>
        db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: OWNER,
                itemId: REC,
                transcriptionId: transcriptId,
                view: "private",
                actorUserId: OWNER,
                trigger: "auto",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "ready",
            })
            .returning({ id: learnRuns.id })
            .then((rows) => rows[0]?.id ?? "");

    const held = async () =>
        (
            await db()
                .select({ at: chatterItems.summaryDueAt })
                .from(chatterItems)
                .where(eq(chatterItems.id, REC))
        )[0]?.at ?? null;

    const passJob = async () =>
        (
            await db()
                .select()
                .from(asyncJobs)
                .where(eq(asyncJobs.kind, LEARN_CORRECT_JOB_KIND))
        )[0];

    const runPass = (passId: string, jobId: string) =>
        correctionPassJobHandler.run({
            payload: { passId },
            userId: OWNER,
            jobId,
            attempt: 1,
            maxAttempts: 2,
            signal: new AbortController().signal,
            reportProgress: () => {},
        });

    async function finish() {
        await readyRun();
        const access = await requireRecordingView(OWNER, REC, "private");
        return finishReview(access, OWNER, { versions: {} });
    }

    it("is queued by a finished review, holds the release, and writes its fixes", async () => {
        const finished = await finish();
        expect(finished).toMatchObject({
            status: "finished",
            correcting: true,
        });
        expect(await held()).not.toBeNull();
        const job = await passJob();
        expect(job?.status).toBe("pending");
        const passId = (job?.payload as { passId: string }).passId;

        createCompletion.mockResolvedValueOnce(
            reply({
                fixes: [
                    {
                        turn: 0,
                        heard: "Oryon",
                        replacement: "Orion",
                        context: "",
                        target: { entityId: orion },
                    },
                    {
                        turn: 0,
                        heard: "sklat",
                        replacement: "sklad",
                        context: "",
                        target: null,
                    },
                    {
                        turn: 1,
                        heard: "dodáme v pátek a víc",
                        replacement: "x",
                        context: "",
                        target: null,
                    },
                ],
            }),
        );
        const result = await runPass(passId, job?.id ?? "");
        expect(result).toMatchObject({ status: "finished", written: 3 });

        const corrections = await listCorrections(OWNER, transcriptId);
        expect(
            corrections.map((c) => [
                c.turnIndex,
                c.heard,
                c.replacement,
                c.kind,
                c.targetEntityId,
                c.passId,
            ]),
        ).toEqual([
            [0, "Oryon", "Orion", "fix", orion, passId],
            [0, "sklat", "sklad", "fix", null, passId],
            [1, "Oryon", "Orion", "fix", orion, passId],
        ]);
        const [pass] = await db()
            .select()
            .from(transcriptCorrectionPasses)
            .where(eq(transcriptCorrectionPasses.id, passId));
        expect(pass?.status).toBe("finished");
        expect(pass?.path).toBe("fallback");
        expect(pass?.stats).toMatchObject({
            written: 3,
            proposed: 3,
            dropped_not_found: 1,
        });
        // What automatic Learn held back is released now.
        expect(await held()).toBeNull();
        const release = await db()
            .select()
            .from(asyncJobs)
            .where(eq(asyncJobs.kind, "learn.release"));
        expect(release).toHaveLength(1);
        // The model read the Almanac and the transcript.
        const prompt = JSON.stringify(createCompletion.mock.calls[0]?.[0]);
        expect(prompt).toContain("Orion");
        expect(prompt).toContain("sklat");
    });

    it("is not queued when the person turned it off", async () => {
        await db()
            .insert(userSettings)
            .values({ userId: OWNER, correctAfterLearn: false });
        const finished = await finish();
        expect(finished.correcting).toBe(false);
        expect(await passJob()).toBeUndefined();
        expect(await held()).toBeNull();
    });

    it("goes nowhere on a transcript changed since, and still releases", async () => {
        await finish();
        const job = await passJob();
        const passId = (job?.payload as { passId: string }).passId;
        await db()
            .update(transcriptions)
            .set({ revision: 1 })
            .where(eq(transcriptions.id, transcriptId));
        const result = await runPass(passId, job?.id ?? "");
        expect(result).toMatchObject({ skipped: "superseded", written: 0 });
        expect(createCompletion).not.toHaveBeenCalled();
        expect(
            await db()
                .select()
                .from(transcriptCorrections)
                .where(eq(transcriptCorrections.transcriptionId, transcriptId)),
        ).toEqual([]);
        expect(await held()).toBeNull();
    });

    it("is queued by a Learn run that found nothing to review", async () => {
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: OWNER,
                itemId: REC,
                transcriptionId: transcriptId,
                view: "private",
                actorUserId: OWNER,
                trigger: "auto",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "queued",
            })
            .returning({ id: learnRuns.id });
        createCompletion
            .mockResolvedValueOnce(reply({ mentions: [] }))
            .mockResolvedValueOnce(
                reply({
                    newRecords: [],
                    speakers: [],
                    corrections: [],
                    facts: [],
                    relationPhrases: [],
                }),
            );
        await learnJobHandler.run({
            payload: { runId: run?.id ?? "" },
            userId: OWNER,
            jobId: "learn-job",
            attempt: 1,
            maxAttempts: 2,
            signal: new AbortController().signal,
            reportProgress: () => {},
        });
        const [finishedRun] = await db()
            .select({ status: learnRuns.status })
            .from(learnRuns)
            .where(eq(learnRuns.id, run?.id ?? ""));
        expect(finishedRun?.status).toBe("finished");
        const job = await passJob();
        expect(job?.status).toBe("pending");
        // Still held: the pass releases it.
        expect(await held()).not.toBeNull();
        const passes = await db()
            .select()
            .from(transcriptCorrectionPasses)
            .where(
                and(
                    eq(transcriptCorrectionPasses.recordingId, REC),
                    eq(transcriptCorrectionPasses.learnRunId, run?.id ?? ""),
                ),
            );
        expect(passes).toHaveLength(1);
    });
});
