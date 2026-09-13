/**
 * The generic job worker.
 *
 * This is where the promise "unattended work is not lost when the container
 * restarts" is actually kept, so the cases below are mostly about failure:
 * a claim taken over mid-run, a handler that ignores its timeout, a payload
 * written by a different deploy, a job that has used its attempts. Each of
 * them has a wrong behaviour that looks fine in the happy path -- running a
 * job twice, holding a worker slot forever, retrying something that can never
 * succeed -- and none of them would show up in a test that only queues a job
 * and watches it finish.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queries } = vi.hoisted(() => ({
    queries: {
        claimDueJobs: vi.fn(),
        completeJob: vi.fn(),
        failJobAttempt: vi.fn(),
        heartbeatJob: vi.fn(),
        reclaimStaleJobs: vi.fn(),
        buryExhaustedStaleJobs: vi.fn(),
        pruneFinishedJobs: vi.fn(),
        releaseClaimedJobs: vi.fn(),
        countPendingJobs: vi.fn(),
    },
}));

vi.mock("@/db/queries/async-jobs", () => queries);
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

import { clearJobHandlers, registerJobHandler } from "@/lib/jobs/registry";
import { JobAbortedError } from "@/lib/jobs/retryable";
import type { JobHandler } from "@/lib/jobs/types";
import { InvalidJobPayloadError } from "@/lib/jobs/types";
import {
    __resetJobWorkerForTests,
    heldClaims,
    releaseInFlightJobs,
    tick,
    waitForIdle,
} from "@/lib/jobs/worker";
import { captureServerException } from "@/lib/posthog-server";

interface TestPayload {
    value?: string;
}

function testHandler(
    overrides: Partial<JobHandler<TestPayload>> = {},
): JobHandler<TestPayload> {
    return {
        kind: "test",
        concurrency: 1,
        maxAttempts: 3,
        timeoutMs: 5_000,
        parsePayload: (raw) => raw as TestPayload,
        run: async () => ({ ok: true }),
        ...overrides,
    };
}

/** A claimed row as `claimDueJobs` returns it. */
function claimed(overrides: Record<string, unknown> = {}) {
    return {
        id: "job-1",
        userId: "user-1",
        kind: "test",
        subjectId: "rec-1",
        payload: {},
        attempts: 1,
        maxAttempts: 3,
        claimToken: "token-1",
        ...overrides,
    };
}

/**
 * A handler whose runs all hang until released. Every started run is held, not
 * just the most recent, so a test that starts two and releases once does not
 * leave the first hanging forever.
 */
function heldJobs() {
    const resolvers: (() => void)[] = [];
    return {
        run: () =>
            new Promise<{ ok: true }>((resolve) => {
                resolvers.push(() => resolve({ ok: true }));
            }),
        releaseAll: () => {
            for (const resolve of resolvers.splice(0)) resolve();
        },
    };
}

/** Claim the given jobs once, then nothing on later ticks. */
function claimOnce(...jobs: ReturnType<typeof claimed>[]) {
    queries.claimDueJobs.mockResolvedValueOnce(jobs).mockResolvedValue([]);
}

async function runTick() {
    await tick();
    await waitForIdle();
}

describe("job worker", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __resetJobWorkerForTests();
        clearJobHandlers();
        queries.claimDueJobs.mockResolvedValue([]);
        queries.reclaimStaleJobs.mockResolvedValue(0);
        queries.buryExhaustedStaleJobs.mockResolvedValue(0);
        queries.pruneFinishedJobs.mockResolvedValue(0);
        queries.heartbeatJob.mockResolvedValue(true);
        queries.completeJob.mockResolvedValue(true);
        queries.releaseClaimedJobs.mockResolvedValue(0);
        queries.countPendingJobs.mockResolvedValue(0);
        queries.failJobAttempt.mockResolvedValue({
            status: "pending",
            attempts: 1,
        });
    });

    afterEach(() => {
        __resetJobWorkerForTests();
        clearJobHandlers();
    });

    it("runs a claimed job and records its result against the claim", async () => {
        registerJobHandler(
            testHandler({ run: async () => ({ provider: "openai" }) }),
        );
        claimOnce(claimed());

        await runTick();

        expect(queries.completeJob).toHaveBeenCalledWith({
            jobId: "job-1",
            claimToken: "token-1",
            result: { provider: "openai" },
        });
        expect(queries.failJobAttempt).not.toHaveBeenCalled();
    });

    it("hands the handler the payload its own parser produced", async () => {
        const run = vi.fn().mockResolvedValue(undefined);
        registerJobHandler(
            testHandler({
                parsePayload: (raw) => ({ value: String(raw.value ?? "") }),
                run,
            }),
        );
        claimOnce(claimed({ payload: { value: 42 } }));

        await runTick();

        expect(run.mock.calls[0][0]).toMatchObject({
            jobId: "job-1",
            userId: "user-1",
            attempt: 1,
            maxAttempts: 3,
            payload: { value: "42" },
        });
    });

    it("requeues a retryable failure with a wait", async () => {
        registerJobHandler(
            testHandler({
                run: async () => {
                    throw new Error("fetch failed");
                },
            }),
        );
        claimOnce(claimed());

        await runTick();

        expect(queries.failJobAttempt).toHaveBeenCalledWith(
            expect.objectContaining({
                jobId: "job-1",
                claimToken: "token-1",
                retryable: true,
                delayMs: expect.any(Number),
            }),
        );
        expect(queries.failJobAttempt.mock.calls[0][0].delayMs).toBeGreaterThan(
            0,
        );
    });

    it("buries a failure that another attempt cannot fix", async () => {
        const { AppError, ErrorCode } = await import("@/lib/errors");
        registerJobHandler(
            testHandler({
                run: async () => {
                    throw new AppError(
                        ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
                        "No AI provider configured",
                        400,
                    );
                },
            }),
        );
        queries.failJobAttempt.mockResolvedValue({
            status: "failed",
            attempts: 1,
        });
        claimOnce(claimed());

        await runTick();

        // `retryable: false` is what stops the queue spending two more
        // multi-pass runs discovering the same missing configuration.
        expect(queries.failJobAttempt).toHaveBeenCalledWith(
            expect.objectContaining({ retryable: false }),
        );
    });

    it("stores the mapped message, not the raw one", async () => {
        registerJobHandler(
            testHandler({
                run: async () => {
                    throw new Error("connection to db://user:hunter2@h failed");
                },
            }),
        );
        claimOnce(claimed());

        await runTick();

        // The row is read back by the browser, so the message on it has to be
        // the safe one. The original still reaches the console and PostHog.
        expect(queries.failJobAttempt.mock.calls[0][0].message).not.toContain(
            "hunter2",
        );
    });

    it("treats an unparseable payload as permanent", async () => {
        registerJobHandler(
            testHandler({
                parsePayload: () => {
                    throw new InvalidJobPayloadError("test", "no recordingId");
                },
                run: async () => ({ ok: true }),
            }),
        );
        claimOnce(claimed({ payload: { nonsense: true } }));

        await runTick();

        // A payload that does not parse now will not parse in thirty seconds.
        expect(queries.failJobAttempt).toHaveBeenCalledWith(
            expect.objectContaining({ retryable: false }),
        );
    });

    it("fails an attempt that runs past its handler's ceiling", async () => {
        let aborted = false;
        registerJobHandler(
            testHandler({
                timeoutMs: 10,
                run: async ({ signal }) => {
                    signal.addEventListener("abort", () => {
                        aborted = true;
                    });
                    // Deliberately ignores the signal, as a wedged provider
                    // call would: the worker must not depend on cooperation
                    // to get its slot back.
                    await new Promise((resolve) => setTimeout(resolve, 5_000));
                    return { ok: true };
                },
            }),
        );
        claimOnce(claimed());

        await runTick();

        expect(aborted).toBe(true);
        expect(queries.completeJob).not.toHaveBeenCalled();
        expect(queries.failJobAttempt).toHaveBeenCalledWith(
            // A timeout is usually a provider that stopped answering, so it
            // gets another go rather than being buried.
            expect.objectContaining({ retryable: true }),
        );
    });

    it("abandons a job whose claim was taken over mid-run", async () => {
        // `heartbeatJob` returning false is the queue saying "this is not
        // yours any more". Continuing would mean two workers running the same
        // job, which for a summary means paying twice.
        queries.heartbeatJob.mockResolvedValue(false);
        registerJobHandler(
            testHandler({
                // Comfortably past the heartbeat interval, so the reason the
                // run ends is the lost claim and not its own time limit.
                timeoutMs: 120_000,
                run: async ({ signal }) =>
                    new Promise((_resolve, reject) => {
                        signal.addEventListener("abort", () =>
                            reject(new JobAbortedError()),
                        );
                    }),
            }),
        );
        claimOnce(claimed());

        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const ticked = runTick();
            await vi.advanceTimersByTimeAsync(13_000);
            await ticked;
        } finally {
            vi.useRealTimers();
        }

        expect(queries.completeJob).not.toHaveBeenCalled();
        expect(queries.failJobAttempt).toHaveBeenCalledWith(
            expect.objectContaining({ retryable: false }),
        );
    });

    it("says nothing when the write finds the claim already gone", async () => {
        // `failJobAttempt` returning null means another worker owns the job.
        // There is nothing to record against a claim we no longer hold.
        queries.failJobAttempt.mockResolvedValue(null);
        registerJobHandler(
            testHandler({
                run: async () => {
                    throw new Error("fetch failed");
                },
            }),
        );
        claimOnce(claimed());

        await runTick();

        expect(captureServerException).not.toHaveBeenCalled();
    });

    it("reports only the terminal failure, not each retry", async () => {
        registerJobHandler(
            testHandler({
                run: async () => {
                    throw new Error("fetch failed");
                },
            }),
        );
        claimOnce(claimed());
        await runTick();
        // Still retrying: reporting here would be noise for a job that may
        // well succeed on its next attempt.
        expect(captureServerException).not.toHaveBeenCalled();

        queries.failJobAttempt.mockResolvedValue({
            status: "failed",
            attempts: 3,
        });
        claimOnce(claimed({ attempts: 3 }));
        await runTick();
        expect(captureServerException).toHaveBeenCalledTimes(1);
    });

    it("asks each kind only for the slots it has free", async () => {
        const gate = heldJobs();
        registerJobHandler(testHandler({ concurrency: 2, run: gate.run }));
        queries.claimDueJobs.mockResolvedValue([claimed()]);

        await tick();
        expect(queries.claimDueJobs).toHaveBeenCalledWith("test", 2);

        // One is now in flight, so the next sweep may take only one more --
        // this is the budget that stops several multi-pass jobs from
        // saturating the agent bridge at once.
        queries.claimDueJobs.mockResolvedValue([claimed({ id: "job-2" })]);
        await tick();
        expect(queries.claimDueJobs).toHaveBeenLastCalledWith("test", 1);

        gate.releaseAll();
        await waitForIdle();
    });

    it("does not claim for a kind that is already saturated", async () => {
        const gate = heldJobs();
        registerJobHandler(testHandler({ concurrency: 1, run: gate.run }));
        queries.claimDueJobs.mockResolvedValue([claimed()]);

        await tick();
        queries.claimDueJobs.mockClear();
        await tick();

        expect(queries.claimDueJobs).not.toHaveBeenCalled();
        gate.releaseAll();
        await waitForIdle();
    });

    it("frees the slot again once the job settles", async () => {
        registerJobHandler(testHandler({ concurrency: 1 }));
        claimOnce(claimed());

        await runTick();
        queries.claimDueJobs.mockClear();
        queries.claimDueJobs.mockResolvedValue([]);
        await tick();

        expect(queries.claimDueJobs).toHaveBeenCalledWith("test", 1);
    });

    it("looks for abandoned work on every sweep", async () => {
        registerJobHandler(testHandler());
        queries.reclaimStaleJobs.mockResolvedValue(2);
        queries.buryExhaustedStaleJobs.mockResolvedValue(1);

        await runTick();

        // This is the restart path: a container killed mid-job leaves a row
        // nothing is heartbeating, and only this notices.
        expect(queries.reclaimStaleJobs).toHaveBeenCalled();
        expect(queries.buryExhaustedStaleJobs).toHaveBeenCalled();
    });

    it("survives a database that is refusing the sweep", async () => {
        registerJobHandler(testHandler());
        queries.reclaimStaleJobs.mockRejectedValue(new Error("db down"));

        // A worker that throws out of its own interval stops sweeping
        // forever, which would silently strand every queued job.
        await expect(tick()).resolves.toBeUndefined();
        expect(captureServerException).toHaveBeenCalledWith(expect.any(Error), {
            source: "worker:jobs",
        });
    });

    it("skips a kind whose handler this deploy no longer has", async () => {
        // Nothing registered for "test", so nothing claims those rows -- they
        // wait rather than erroring on every sweep.
        queries.claimDueJobs.mockResolvedValue([claimed()]);
        await runTick();
        expect(queries.claimDueJobs).not.toHaveBeenCalled();
    });

    it("tracks the claims it is holding, and forgets them when done", async () => {
        const gate = heldJobs();
        registerJobHandler(testHandler({ run: gate.run }));
        queries.claimDueJobs.mockResolvedValue([claimed()]);

        await tick();
        expect(heldClaims()).toEqual([
            { jobId: "job-1", claimToken: "token-1" },
        ]);

        gate.releaseAll();
        await waitForIdle();
        expect(heldClaims()).toEqual([]);
    });

    it("releases in-flight claims so the next instance can start at once", async () => {
        queries.releaseClaimedJobs.mockResolvedValue(1);

        await releaseInFlightJobs([{ jobId: "job-1", claimToken: "token-1" }]);

        expect(queries.releaseClaimedJobs).toHaveBeenCalledWith([
            { jobId: "job-1", claimToken: "token-1" },
        ]);
    });

    it("does not fail a shutdown over a release that could not be written", async () => {
        // The stale reclaim is the backstop and needs nothing from us, so a
        // failure here costs a couple of minutes of latency, never the job.
        queries.releaseClaimedJobs.mockRejectedValue(new Error("db gone"));
        await expect(
            releaseInFlightJobs([{ jobId: "job-1", claimToken: "t" }]),
        ).resolves.toBeUndefined();
    });

    it("writes nothing when there is nothing to release", async () => {
        await releaseInFlightJobs([]);
        expect(queries.releaseClaimedJobs).not.toHaveBeenCalled();
    });

    it("prunes finished rows once, not on every sweep", async () => {
        registerJobHandler(testHandler());

        await runTick();
        expect(queries.pruneFinishedJobs).toHaveBeenCalledTimes(1);

        await runTick();
        // Finished rows expire in a day; sweeping is every few seconds.
        // Checking each time would be thousands of pointless statements.
        expect(queries.pruneFinishedJobs).toHaveBeenCalledTimes(1);
    });
});
