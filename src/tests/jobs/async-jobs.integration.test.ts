/**
 * The queue's SQL, against a real PostgreSQL.
 *
 * Everything else in `src/tests/jobs/` runs against mocked queries, which
 * proves the worker calls the right things but says nothing about whether
 * those things do what their names claim. The parts that only a real database
 * can answer are exactly the parts that matter most here:
 *
 *   - `for update skip locked`, which is what stops two instances running the
 *     same summary and billing the user twice;
 *   - the partial unique index, which is what makes a double-clicked button
 *     one job rather than two;
 *   - the `case` expressions in `failJobAttempt`, where "retry this" and
 *     "bury this" differ by one branch;
 *   - the heartbeat arithmetic behind reclaiming work from a container that
 *     was killed mid-job, which is the whole reason the table exists.
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
import { asyncJobs, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef } = vi.hoisted(() => {
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
    return { dbProxy: proxy, dbRef: ref };
});

vi.mock("@/db", () => ({ db: dbProxy }));

import {
    buryExhaustedStaleJobs,
    claimDueJobs,
    completeJob,
    countPendingJobs,
    enqueueJob,
    failJobAttempt,
    getActiveJob,
    getJobForUser,
    getLatestJobForSubject,
    heartbeatJob,
    listJobsForUser,
    pruneFinishedJobs,
    reclaimStaleJobs,
    releaseClaimedJobs,
} from "@/db/queries/async-jobs";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("async_jobs queue (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    const USER = "job-user-1";
    const OTHER_USER = "job-user-2";

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "async_jobs",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        if (!database) throw new Error("test database was not initialized");
        await database.db.delete(asyncJobs);
        await database.db.delete(users);
        await database.db.insert(users).values([
            { id: USER, email: `${USER}@example.test` },
            { id: OTHER_USER, email: `${OTHER_USER}@example.test` },
        ]);
    });

    function raw() {
        if (!database) throw new Error("test database was not initialized");
        return database.sql;
    }

    /** Shift a job's clock columns into the past, since `now()` is the server's. */
    async function ageJob(
        jobId: string,
        column:
            | "heartbeat_at"
            | "started_at"
            | "completed_at"
            | "next_attempt_at",
        seconds: number,
    ) {
        const sql = raw();
        await sql`
            update async_jobs
            set ${sql(column)} = now() - make_interval(secs => ${seconds})
            where id = ${jobId}
        `;
    }

    function queue(overrides: Record<string, unknown> = {}) {
        return enqueueJob({
            userId: USER,
            kind: "summary",
            subjectId: "rec-1",
            payload: { recordingId: "rec-1", trigger: "manual" },
            maxAttempts: 3,
            ...overrides,
        });
    }

    describe("enqueueJob", () => {
        it("stores the payload and starts the job pending", async () => {
            const { job, created } = await queue();

            expect(created).toBe(true);
            expect(job.status).toBe("pending");
            expect(job.attempts).toBe(0);
            expect(job.payload).toEqual({
                recordingId: "rec-1",
                trigger: "manual",
            });
        });

        it("returns the live job instead of queueing a second for the same subject", async () => {
            const first = await queue();
            const second = await queue();

            // The partial unique index, not a check-then-insert: two requests
            // racing the same check would both pass it.
            expect(second.created).toBe(false);
            expect(second.job.id).toBe(first.job.id);
            expect(await countPendingJobs("summary")).toBe(1);
        });

        it("converges concurrent enqueues on one job", async () => {
            const results = await Promise.all([
                queue(),
                queue(),
                queue(),
                queue(),
            ]);

            const ids = new Set(results.map((r) => r.job.id));
            expect(ids.size).toBe(1);
            expect(results.filter((r) => r.created)).toHaveLength(1);
        });

        it("allows a new job once the previous one has finished", async () => {
            const first = await queue();
            const [claimedJob] = await claimDueJobs("summary", 1);
            await completeJob({
                jobId: claimedJob.id,
                claimToken: claimedJob.claimToken,
                result: {},
            });

            const second = await queue();

            // The index is partial on purpose: regenerating a summary must
            // stay possible.
            expect(second.created).toBe(true);
            expect(second.job.id).not.toBe(first.job.id);
        });

        it("does not constrain kinds with no subject", async () => {
            const first = await queue({ subjectId: null, kind: "sweep" });
            const second = await queue({ subjectId: null, kind: "sweep" });

            // Postgres treats NULLs as distinct. A nightly sweep has no
            // natural subject and should not be deduped against itself.
            expect(second.created).toBe(true);
            expect(second.job.id).not.toBe(first.job.id);
        });

        it("holds a delayed job back from the queue", async () => {
            await queue({ delayMs: 60_000 });
            expect(await claimDueJobs("summary", 5)).toHaveLength(0);
        });
    });

    describe("claimDueJobs", () => {
        it("claims a due job, marks it processing and counts the attempt", async () => {
            await queue();

            const [claimedJob] = await claimDueJobs("summary", 5);

            expect(claimedJob.claimToken).toBeTruthy();
            // Counted at claim time, so a job that kills its process still
            // spends an attempt rather than crashing the container forever.
            expect(claimedJob.attempts).toBe(1);

            const row = await getJobForUser(claimedJob.id, USER);
            expect(row?.status).toBe("processing");
            expect(row?.heartbeatAt).not.toBeNull();
        });

        it("gives the same job to only one of two racing workers", async () => {
            await queue();

            const [a, b] = await Promise.all([
                claimDueJobs("summary", 5),
                claimDueJobs("summary", 5),
            ]);

            // `for update skip locked`. Without it both instances run the
            // same summary and the user pays twice.
            expect(a.length + b.length).toBe(1);
        });

        it("claims only the kind it was asked for", async () => {
            await queue({ kind: "summary", subjectId: "rec-1" });
            await queue({ kind: "knowledge-base", subjectId: "rec-1" });

            const claimed = await claimDueJobs("summary", 5);

            expect(claimed).toHaveLength(1);
            expect(claimed[0].kind).toBe("summary");
        });

        it("runs a higher priority job first", async () => {
            await queue({ subjectId: "rec-auto", priority: 0 });
            await queue({ subjectId: "rec-manual", priority: 10 });

            const [first] = await claimDueJobs("summary", 1);

            // A summary someone is watching should not queue behind a sync's
            // worth of automatic ones.
            expect(first.subjectId).toBe("rec-manual");
        });

        it("takes the longest-waiting first within a priority", async () => {
            const older = await queue({ subjectId: "rec-a" });
            await queue({ subjectId: "rec-b" });
            await ageJob(older.job.id, "next_attempt_at", 60);

            const [first] = await claimDueJobs("summary", 1);

            // Otherwise a busy queue can starve whatever happens to sort
            // last, which for a summary means a recording that never gets one.
            expect(first.subjectId).toBe("rec-a");
        });

        it("honours the limit and returns nothing for a limit of zero", async () => {
            await queue({ subjectId: "rec-a" });
            await queue({ subjectId: "rec-b" });
            await queue({ subjectId: "rec-c" });

            expect(await claimDueJobs("summary", 2)).toHaveLength(2);
            expect(await claimDueJobs("summary", 0)).toHaveLength(0);
        });
    });

    describe("heartbeatJob", () => {
        it("records progress and keeps the claim alive", async () => {
            await queue();
            const [job] = await claimDueJobs("summary", 1);

            expect(
                await heartbeatJob(job.id, job.claimToken, {
                    phase: "passes",
                    completed: 1,
                    total: 3,
                }),
            ).toBe(true);

            const row = await getJobForUser(job.id, USER);
            expect(row?.progress).toMatchObject({
                phase: "passes",
                completed: 1,
            });
        });

        it("refuses a claim that is no longer held", async () => {
            await queue();
            const [job] = await claimDueJobs("summary", 1);

            // This is how a worker learns its job was taken over, and the cue
            // to stop rather than run it a second time.
            expect(await heartbeatJob(job.id, "not-the-token")).toBe(false);
        });
    });

    describe("completeJob", () => {
        it("stores the result and stamps completion", async () => {
            await queue();
            const [job] = await claimDueJobs("summary", 1);

            expect(
                await completeJob({
                    jobId: job.id,
                    claimToken: job.claimToken,
                    result: { provider: "openai" },
                }),
            ).toBe(true);

            const row = await getJobForUser(job.id, USER);
            expect(row?.status).toBe("completed");
            expect(row?.result).toEqual({ provider: "openai" });
            expect(row?.completedAt).not.toBeNull();
        });

        it("writes nothing for a superseded claim", async () => {
            await queue();
            const [job] = await claimDueJobs("summary", 1);

            expect(
                await completeJob({
                    jobId: job.id,
                    claimToken: "stale",
                    result: {},
                }),
            ).toBe(false);
            expect((await getJobForUser(job.id, USER))?.status).toBe(
                "processing",
            );
        });
    });

    describe("failJobAttempt", () => {
        it("requeues a retryable failure with its wait pushed out", async () => {
            await queue();
            const [job] = await claimDueJobs("summary", 1);

            const outcome = await failJobAttempt({
                jobId: job.id,
                claimToken: job.claimToken,
                message: "provider unavailable",
                code: "UPSTREAM_BAD_RESPONSE",
                retryable: true,
                delayMs: 30_000,
            });

            expect(outcome).toEqual({ status: "pending", attempts: 1 });
            const row = await getJobForUser(job.id, USER);
            expect(row?.claimToken).toBeNull();
            expect(row?.lastError).toBe("provider unavailable");
            expect(row?.completedAt).toBeNull();
            // Pushed into the future, which is what actually implements the
            // backoff -- and means the job is not immediately reclaimable.
            expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(
                Date.now() + 20_000,
            );
            expect(await claimDueJobs("summary", 5)).toHaveLength(0);
        });

        it("buries a failure nothing can retry, even on the first attempt", async () => {
            await queue();
            const [job] = await claimDueJobs("summary", 1);

            const outcome = await failJobAttempt({
                jobId: job.id,
                claimToken: job.claimToken,
                message: "No AI provider configured",
                code: "AI_PROVIDER_NOT_CONFIGURED",
                retryable: false,
                delayMs: 30_000,
            });

            expect(outcome?.status).toBe("failed");
            const row = await getJobForUser(job.id, USER);
            expect(row?.completedAt).not.toBeNull();
            // The token is deliberately kept: clearing it is what lets a job
            // be claimed again, so a terminal row keeps it so that a late
            // write from the failed attempt still matches nothing.
            expect(row?.claimToken).toBe(job.claimToken);
        });

        it("buries a retryable failure once the attempts are gone", async () => {
            await queue({ maxAttempts: 2 });

            const [first] = await claimDueJobs("summary", 1);
            await failJobAttempt({
                jobId: first.id,
                claimToken: first.claimToken,
                message: "blip",
                retryable: true,
                delayMs: 0,
            });

            const [second] = await claimDueJobs("summary", 1);
            const outcome = await failJobAttempt({
                jobId: second.id,
                claimToken: second.claimToken,
                message: "blip",
                retryable: true,
                delayMs: 0,
            });

            expect(outcome).toEqual({ status: "failed", attempts: 2 });
        });

        it("records nothing against a claim it no longer holds", async () => {
            await queue();
            const [job] = await claimDueJobs("summary", 1);

            expect(
                await failJobAttempt({
                    jobId: job.id,
                    claimToken: "stale",
                    message: "x",
                    retryable: true,
                    delayMs: 0,
                }),
            ).toBeNull();
        });
    });

    describe("reclaiming work from a worker that stopped", () => {
        it("requeues a job whose heartbeat went silent", async () => {
            await queue();
            const [job] = await claimDueJobs("summary", 1);
            await ageJob(job.id, "heartbeat_at", 600);

            expect(await reclaimStaleJobs(120_000)).toBe(1);

            const row = await getJobForUser(job.id, USER);
            expect(row?.status).toBe("pending");
            expect(row?.claimToken).toBeNull();
            // Not refunded: a hard kill might have been caused by the job
            // itself, so it still runs out of attempts eventually.
            expect(row?.attempts).toBe(1);
            expect(await claimDueJobs("summary", 5)).toHaveLength(1);
        });

        it("leaves a job that is merely slow alone", async () => {
            await queue();
            await claimDueJobs("summary", 1);

            // Ten missed beats is the threshold precisely so a GC pause or a
            // busy event loop does not get a healthy job run twice.
            expect(await reclaimStaleJobs(120_000)).toBe(0);
        });

        it("buries a silent job that has no attempts left", async () => {
            await queue({ maxAttempts: 1 });
            const [job] = await claimDueJobs("summary", 1);
            await ageJob(job.id, "heartbeat_at", 600);

            // Without this a job that reliably kills its process would be
            // reclaimed forever, taking the container with it each time.
            expect(await reclaimStaleJobs(120_000)).toBe(0);
            expect(await buryExhaustedStaleJobs(120_000)).toBe(1);
            expect((await getJobForUser(job.id, USER))?.status).toBe("failed");
        });
    });

    describe("releaseClaimedJobs", () => {
        it("requeues immediately and refunds the interrupted attempt", async () => {
            await queue();
            const [job] = await claimDueJobs("summary", 1);

            expect(
                await releaseClaimedJobs([
                    { jobId: job.id, claimToken: job.claimToken },
                ]),
            ).toBe(1);

            const row = await getJobForUser(job.id, USER);
            expect(row?.status).toBe("pending");
            // Being interrupted by a deploy is not the job's fault; three
            // upgrades in a row should not bury work that never misbehaved.
            expect(row?.attempts).toBe(0);
            // And the replacement instance can take it at once rather than
            // waiting out the stale threshold.
            expect(await claimDueJobs("summary", 5)).toHaveLength(1);
        });

        it("ignores a claim someone else now holds", async () => {
            await queue();
            const [job] = await claimDueJobs("summary", 1);

            expect(
                await releaseClaimedJobs([
                    { jobId: job.id, claimToken: "stale" },
                ]),
            ).toBe(0);
            expect((await getJobForUser(job.id, USER))?.status).toBe(
                "processing",
            );
        });
    });

    describe("pruneFinishedJobs", () => {
        it("deletes settled rows past the window and keeps the rest", async () => {
            const old = await queue({ subjectId: "rec-old" });
            const [claimedOld] = await claimDueJobs("summary", 1);
            await completeJob({
                jobId: claimedOld.id,
                claimToken: claimedOld.claimToken,
                result: {},
            });
            await ageJob(old.job.id, "completed_at", 7 * 24 * 60 * 60);

            const recent = await queue({ subjectId: "rec-recent" });
            const running = await queue({ subjectId: "rec-running" });

            expect(await pruneFinishedJobs(24 * 60 * 60 * 1000, 100)).toBe(1);
            expect(await getJobForUser(old.job.id, USER)).toBeNull();
            expect(await getJobForUser(recent.job.id, USER)).not.toBeNull();
            expect(await getJobForUser(running.job.id, USER)).not.toBeNull();
        });
    });

    describe("lookups", () => {
        it("scopes a job by its owner", async () => {
            const { job } = await queue();

            // A job id travels to the browser and can end up in a log or a
            // bug report. On its own it must grant nothing.
            expect(await getJobForUser(job.id, OTHER_USER)).toBeNull();
            expect(await getJobForUser(job.id, USER)).not.toBeNull();
        });

        it("finds the live job for a subject and stops once it settles", async () => {
            await queue();
            expect(await getActiveJob("summary", "rec-1")).not.toBeNull();

            const [job] = await claimDueJobs("summary", 1);
            // Still active while processing: this is what a reattaching page
            // uses to know work is under way.
            expect(await getActiveJob("summary", "rec-1")).not.toBeNull();

            await completeJob({
                jobId: job.id,
                claimToken: job.claimToken,
                result: {},
            });
            expect(await getActiveJob("summary", "rec-1")).toBeNull();
        });

        it("finds the most recent job for a subject whatever its status", async () => {
            const first = await queue();
            const [job] = await claimDueJobs("summary", 1);
            await completeJob({
                jobId: job.id,
                claimToken: job.claimToken,
                result: {},
            });
            const second = await queue();

            const latest = await getLatestJobForSubject(
                "summary",
                "rec-1",
                USER,
            );
            expect(latest?.id).toBe(second.job.id);
            expect(latest?.id).not.toBe(first.job.id);
        });

        it("lists a user's jobs without leaking anyone else's", async () => {
            await queue();
            await enqueueJob({
                userId: OTHER_USER,
                kind: "summary",
                subjectId: "rec-other",
            });

            const mine = await listJobsForUser(USER);
            expect(mine).toHaveLength(1);
            expect(mine[0].userId).toBe(USER);
        });

        it("filters to live jobs when asked", async () => {
            await queue({ subjectId: "rec-done" });
            const [job] = await claimDueJobs("summary", 1);
            await completeJob({
                jobId: job.id,
                claimToken: job.claimToken,
                result: {},
            });
            await queue({ subjectId: "rec-live" });

            const active = await listJobsForUser(USER, { activeOnly: true });
            expect(active).toHaveLength(1);
            expect(active[0].subjectId).toBe("rec-live");
        });
    });

    describe("cascade", () => {
        it("removes a user's jobs when the user goes", async () => {
            const { job } = await queue();
            if (!database) throw new Error("test database was not initialized");

            await database.db.delete(users).where(eq(users.id, USER));

            // Account deletion must not leave queued work behind to be
            // claimed and run against a user who no longer exists.
            expect(await getJobForUser(job.id, USER)).toBeNull();
        });
    });
});
