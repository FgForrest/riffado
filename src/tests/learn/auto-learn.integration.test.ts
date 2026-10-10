/**
 * Automatic Learn holding the title, summary and topics back (Task 5.5),
 * against a real PostgreSQL: when it holds, what releases it, and that it
 * releases once.
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
    apiRateLimitBuckets,
    asyncJobs,
    chatterItems,
    learnRuns,
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

import { encrypt } from "@/lib/encryption";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { JobDeferredError } from "@/lib/jobs/retryable";
import {
    AUTO_LEARN_HOLD_MS,
    holdForAutoLearn,
    learnReleaseJobHandler,
    releaseAutoLearnHold,
    sweepAutoLearnHolds,
} from "@/lib/learn/auto-learn";
import { recordingFollowUps } from "@/lib/learn/follow-ups";
import { ensureOrgAccount } from "@/lib/org/account";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { titleJobHandler } from "@/lib/recordings/title-job-handler";
import { enqueueTopicsJob } from "@/lib/topics/topics-job";
import { upsertTranscription } from "@/lib/transcription/persist";
import { emitEvent } from "@/lib/webhooks/emit";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const REC = "rec-auto";

describeWithDatabase("automatic Learn holds (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let riffadoId = "";
    let plaudId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "auto_learn",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db().delete(asyncJobs);
        await db().insert(users).values({ id: OWNER, email: "o@example.test" });
        await ensureOrgAccount();
        await db().insert(userSettings).values({
            userId: OWNER,
            autoLearn: true,
            autoSummarize: true,
            autoDetectTopics: true,
            autoGenerateTitle: true,
        });
        await db()
            .insert(apiCredentials)
            .values({
                userId: OWNER,
                provider: "OpenAI",
                apiKey: encrypt("sk-test"),
                defaultModel: "gpt-test",
                isDefaultEnhancement: true,
            });
        await insertRecordings(db(), {
            id: REC,
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 5_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:05Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/rec.mp3`,
            plaudVersion: "1",
        });
        const turns = [
            { speaker: "speaker_0", startMs: 0, endMs: 5_000, text: "Ahoj." },
        ];
        const inserted = await db()
            .insert(transcriptions)
            .values(
                (["riffado", "plaud"] as const).map((source) => ({
                    recordingId: REC,
                    userId: OWNER,
                    text: encryptText("Ahoj."),
                    turns: encryptJsonField(turns),
                    provider: "openai",
                    model: "gpt-4o-transcribe-diarize",
                    source,
                })),
            )
            .returning({
                id: transcriptions.id,
                source: transcriptions.source,
            });
        riffadoId = inserted.find((row) => row.source === "riffado")?.id ?? "";
        plaudId = inserted.find((row) => row.source === "plaud")?.id ?? "";
    });

    const dueAt = async () =>
        (
            await db()
                .select({ at: chatterItems.summaryDueAt })
                .from(chatterItems)
                .where(eq(chatterItems.id, REC))
        )[0]?.at ?? null;

    const kinds = async () =>
        (
            await db()
                .select({ kind: asyncJobs.kind })
                .from(asyncJobs)
                .where(eq(asyncJobs.userId, OWNER))
        )
            .map((row) => row.kind)
            .sort();

    function run(
        status: "queued" | "running" | "ready" | "finished" | "failed",
        transcriptionId = riffadoId,
    ) {
        return db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: OWNER,
                itemId: REC,
                transcriptionId,
                view: "private",
                actorUserId: OWNER,
                trigger: "auto",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status,
            })
            .returning({ id: learnRuns.id })
            .then((rows) => rows[0]?.id ?? "");
    }

    /** Run the queued release job, as the worker would. */
    const runRelease = async () => {
        await learnReleaseJobHandler.run({
            jobId: "job-release",
            userId: OWNER,
            payload: { recordingId: REC },
            attempt: 1,
            maxAttempts: 5,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
        } as unknown as Parameters<typeof learnReleaseJobHandler.run>[0]);
        await db().delete(asyncJobs).where(eq(asyncJobs.kind, "learn.release"));
    };

    const setStatus = (id: string, status: "finished" | "failed") =>
        db().update(learnRuns).set({ status }).where(eq(learnRuns.id, id));

    const hold = () =>
        db()
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + AUTO_LEARN_HOLD_MS) })
            .where(eq(chatterItems.id, REC));

    it("holds the title, summary and topics and starts Learn, queuing nothing else", async () => {
        const before = Date.now();

        expect(
            await holdForAutoLearn({
                userId: OWNER,
                recordingId: REC,
                timed: true,
            }),
        ).toBe(true);

        const due = await dueAt();
        expect(due?.getTime()).toBeGreaterThanOrEqual(
            before + AUTO_LEARN_HOLD_MS - 1_000,
        );
        // No phantom summary, title or topics job: only the run's.
        expect(await kinds()).toEqual(["learn.run"]);
        const runs = await db()
            .select({ trigger: learnRuns.trigger, status: learnRuns.status })
            .from(learnRuns);
        expect(runs).toEqual([{ trigger: "auto", status: "queued" }]);
    });

    it("holds nothing when the person or the transcript does not allow it", async () => {
        const tryHold = (timed = true) =>
            holdForAutoLearn({ userId: OWNER, recordingId: REC, timed });

        expect(await tryHold(false)).toBe(false);
        await db()
            .update(userSettings)
            .set({ autoLearn: false })
            .where(eq(userSettings.userId, OWNER));
        expect(await tryHold()).toBe(false);

        expect(await dueAt()).toBeNull();
        expect(await kinds()).toEqual([]);
    });

    it("waits while a run is queued or awaits review, and releases once when the last review is done", async () => {
        await hold();
        const ready = await run("ready");

        expect(await releaseAutoLearnHold(REC)).toBe(false);
        expect(await dueAt()).not.toBeNull();

        await setStatus(ready, "finished");
        expect(await releaseAutoLearnHold(REC)).toBe(true);
        expect(await dueAt()).toBeNull();
        // Cleared and queued in one transaction: one durable job.
        expect(await kinds()).toEqual(["learn.release"]);

        // Released already: nothing is queued twice.
        expect(await releaseAutoLearnHold(REC)).toBe(false);
        expect(await kinds()).toEqual(["learn.release"]);

        await runRelease();
        expect(await kinds()).toEqual(["summary", "title.generate", "topics"]);
    });

    it("tells the page what waits and which of its jobs are still to finish", async () => {
        await hold();
        const ready = await run("ready");
        expect(await recordingFollowUps(OWNER, REC)).toEqual({
            held: true,
            pending: [],
        });

        await setStatus(ready, "finished");
        await releaseAutoLearnHold(REC);
        expect(await recordingFollowUps(OWNER, REC)).toEqual({
            held: false,
            pending: ["learn.release"],
        });

        await runRelease();
        expect(await recordingFollowUps(OWNER, REC)).toEqual({
            held: false,
            pending: ["summary", "title.generate", "topics"],
        });

        await db()
            .update(asyncJobs)
            .set({ status: "completed" })
            .where(eq(asyncJobs.kind, "title.generate"));
        expect((await recordingFollowUps(OWNER, REC))?.pending).toEqual([
            "summary",
            "topics",
        ]);
        // Someone else's recording is not found, whatever it waits for.
        expect(await recordingFollowUps("someone-else", REC)).toBeNull();
    });

    it("releases when the run failed", async () => {
        await hold();
        const queued = await run("queued");
        expect(await releaseAutoLearnHold(REC)).toBe(false);

        await setStatus(queued, "failed");

        expect(await releaseAutoLearnHold(REC)).toBe(true);
    });

    it("with two transcripts, waits for both reviews", async () => {
        await hold();
        const riffado = await run("ready", riffadoId);
        const plaud = await run("ready", plaudId);

        await setStatus(riffado, "finished");
        expect(await releaseAutoLearnHold(REC)).toBe(false);

        await setStatus(plaud, "finished");
        expect(await releaseAutoLearnHold(REC)).toBe(true);
    });

    it("releases when the time is up, even with a review still waiting", async () => {
        await hold();
        await run("ready");

        expect(await sweepAutoLearnHolds(new Date())).toBe(0);
        expect(
            await sweepAutoLearnHolds(
                new Date(Date.now() + AUTO_LEARN_HOLD_MS + 60_000),
            ),
        ).toBe(1);
        expect(await dueAt()).toBeNull();
        expect(await kinds()).toEqual(["learn.release"]);
    });

    it("does not let holds still waiting for their review crowd out one to release", async () => {
        // First in line: a review waiting, its time not up.
        await hold();
        await run("ready");
        // Behind it: a hold nothing holds any more.
        await insertRecordings(db(), {
            id: "rec-free",
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: "plaud-free",
            filename: encryptText("Free"),
            duration: 5_000,
            startTime: new Date("2026-09-01T11:00:00Z"),
            endTime: new Date("2026-09-01T11:00:05Z"),
            filesize: 11,
            fileMd5: "1".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/free.mp3`,
            plaudVersion: "1",
            summaryDueAt: new Date(Date.now() + AUTO_LEARN_HOLD_MS + 1_000),
        });

        // A batch of one.
        expect(await sweepAutoLearnHolds(new Date(), 1)).toBe(1);
        const [free] = await db()
            .select({ at: chatterItems.summaryDueAt })
            .from(chatterItems)
            .where(eq(chatterItems.id, "rec-free"));
        expect(free?.at).toBeNull();
        expect(await dueAt()).not.toBeNull();
    });

    it("never lets an expired sweep release a hold that was renewed", async () => {
        await hold();
        const later = new Date(Date.now() + AUTO_LEARN_HOLD_MS + 60_000);
        // Renewed after the sweep read it as due.
        expect(
            await releaseAutoLearnHold(REC, {
                expired: true,
                now: new Date(Date.now() + 60_000),
            }),
        ).toBe(false);
        expect(await dueAt()).not.toBeNull();
        expect(
            await releaseAutoLearnHold(REC, { expired: true, now: later }),
        ).toBe(true);
    });

    it("lets the sweep release a hold whose run's job died, without waiting 72 h", async () => {
        await hold();
        const [job] = await db()
            .insert(asyncJobs)
            .values({
                userId: OWNER,
                kind: "learn.run",
                subjectId: "gone",
                status: "failed",
            })
            .returning({ id: asyncJobs.id });
        const dead = await run("running");
        await db()
            .update(learnRuns)
            .set({ jobId: job?.id ?? "" })
            .where(eq(learnRuns.id, dead));

        expect(await sweepAutoLearnHolds(new Date())).toBe(1);
        expect(await dueAt()).toBeNull();
    });

    it("releases when the run's job died, however its row reads", async () => {
        await hold();
        const [job] = await db()
            .insert(asyncJobs)
            .values({
                userId: OWNER,
                kind: "learn.run",
                subjectId: "other",
                status: "failed",
            })
            .returning({ id: asyncJobs.id });
        const dead = await run("running");
        await db()
            .update(learnRuns)
            .set({ jobId: job?.id ?? "" })
            .where(eq(learnRuns.id, dead));

        expect(await releaseAutoLearnHold(REC)).toBe(true);
    });

    it("drops the hold when a new Riffado transcript is written, not a Plaud one", async () => {
        await hold();
        const rewrite = (source: "riffado" | "plaud") =>
            upsertTranscription({
                userId: OWNER,
                recordingId: REC,
                text: "Ahoj všem.",
                detectedLanguage: "cs",
                source,
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                turns: [
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 5_000,
                        text: "Ahoj všem.",
                    },
                ],
            });

        await rewrite("plaud");
        expect(await dueAt()).not.toBeNull();
        await rewrite("riffado");
        expect(await dueAt()).toBeNull();
        // Nothing queued: that transcription makes its own, or holds again.
        expect(await kinds()).toEqual([]);
    });

    it("makes the summary again where the one there was made from an older reading", async () => {
        await hold();
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: REC,
                userId: OWNER,
                transcriptionId: riffadoId,
                summary: encryptText("Made before the review."),
                provider: "openai",
                model: "gpt-test",
                source: "riffado",
                inputFingerprint: "an-older-reading",
            });

        expect(await releaseAutoLearnHold(REC)).toBe(true);
        await runRelease();

        expect(await kinds()).toEqual(["summary", "title.generate", "topics"]);
    });

    it("queues what waited for when the hourly limit opens again, rather than dropping it", async () => {
        for (let i = 0; i < 20; i++) {
            await consumeRateLimitBucket(`auto-summary:user:${OWNER}`, {
                limit: 20,
                windowMs: 60 * 60 * 1000,
            });
        }
        await hold();

        expect(await releaseAutoLearnHold(REC)).toBe(true);
        await runRelease();

        const [summary] = await db()
            .select({ nextAttemptAt: asyncJobs.nextAttemptAt })
            .from(asyncJobs)
            .where(eq(asyncJobs.kind, "summary"));
        expect(summary?.nextAttemptAt.getTime()).toBeGreaterThan(
            Date.now() + 30 * 60 * 1000,
        );
    });

    it("waits for the other transcript's topics job, spending the caps once", async () => {
        await db().delete(apiRateLimitBuckets);
        await enqueueTopicsJob({
            userId: OWNER,
            recordingId: REC,
            source: "plaud",
            trigger: "auto",
        });
        await hold();
        expect(await releaseAutoLearnHold(REC)).toBe(true);

        // Put off while the Plaud topics are detected, twice.
        await expect(runRelease()).rejects.toBeInstanceOf(JobDeferredError);
        await expect(runRelease()).rejects.toBeInstanceOf(JobDeferredError);
        await db().delete(asyncJobs).where(eq(asyncJobs.kind, "topics"));
        await runRelease();

        expect(await kinds()).toEqual(["summary", "title.generate", "topics"]);
        const [topics] = await db()
            .select({ payload: asyncJobs.payload })
            .from(asyncJobs)
            .where(eq(asyncJobs.kind, "topics"));
        expect(topics?.payload.source).toBe("riffado");
        for (const cap of ["auto-summary", "auto-topics"]) {
            const next = await consumeRateLimitBucket(`${cap}:user:${OWNER}`, {
                limit: 20,
                windowMs: 60 * 60 * 1000,
            });
            // The release's one, and this one.
            expect(next.remaining).toBe(18);
        }
    });

    it("keeps a summary the person made while it waited", async () => {
        await hold();
        await db()
            .insert(aiEnhancements)
            .values({
                itemId: REC,
                userId: OWNER,
                summary: encryptText("Their own summary."),
                provider: "openai",
                model: "gpt-test",
                source: "riffado",
            });

        expect(await releaseAutoLearnHold(REC)).toBe(true);
        await runRelease();

        expect(await kinds()).toEqual(["title.generate", "topics"]);
        const summaries = await db()
            .select({ id: aiEnhancements.id })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, REC),
                    eq(aiEnhancements.userId, OWNER),
                ),
            );
        expect(summaries).toHaveLength(1);
    });

    describe("the title job", () => {
        const runTitle = () =>
            titleJobHandler.run({
                jobId: "job-1",
                userId: OWNER,
                payload: { recordingId: REC },
                attempt: 1,
                maxAttempts: 3,
                signal: new AbortController().signal,
                reportProgress: vi.fn(),
            } as unknown as Parameters<typeof titleJobHandler.run>[0]);
        const title = async () =>
            decryptText(
                (
                    await db()
                        .select({ filename: chatterItems.title })
                        .from(chatterItems)
                        .where(eq(chatterItems.id, REC))
                )[0]?.filename ?? "",
            );

        it("names the recording from its transcript and says so with recording.updated", async () => {
            vi.mocked(emitEvent).mockClear();

            expect(await runTitle()).toEqual({ retitled: true });

            expect(await title()).toBe("Held title");
            expect(emitEvent).toHaveBeenCalledWith(
                "recording.updated",
                OWNER,
                REC,
            );
        });

        it("waits while a newer hold is on the recording", async () => {
            await hold();
            expect(await runTitle()).toEqual({ skipped: "held" });
            expect(await title()).toBe("Weekly");
        });

        it("keeps a title the person set while it waited", async () => {
            await db()
                .update(chatterItems)
                .set({
                    title: encryptText("Their name"),
                    titleEditedAt: new Date(),
                })
                .where(eq(chatterItems.id, REC));
            vi.mocked(emitEvent).mockClear();

            expect(await runTitle()).toEqual({ retitled: false });

            expect(await title()).toBe("Their name");
            expect(emitEvent).not.toHaveBeenCalled();
        });
    });
});
