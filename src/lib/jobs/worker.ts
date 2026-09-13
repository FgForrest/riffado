/**
 * The generic background job worker.
 *
 * Riffado's five existing workers each own one table and one job shape. This
 * one owns none: it claims rows from `async_jobs`, looks the `kind` up in the
 * registry, and applies the same claiming, heartbeating, timeout, retry and
 * reclaim rules to every kind. Adding durable work is then a handler and a
 * registration.
 *
 * ## What "survives a restart" actually means here
 *
 * A job in flight when the container dies is not recovered -- the provider
 * call it was making is gone with the process. What survives is the
 * INTENTION: the row stays in `processing` with a claim nobody is refreshing,
 * and the next instance reclaims and re-runs it. So a summary interrupted by
 * an upgrade is re-generated rather than silently never appearing, which is
 * the failure this exists to remove.
 *
 * That recovery is driven entirely by the missed heartbeat, and deliberately
 * asks nothing of the dying process -- which is the only design that works
 * for the cases that matter, since an OOM kill and a `SIGKILL` get no chance
 * to tidy up. See `releaseInFlightJobs` for why there is no `SIGTERM` handler
 * shortening the wait.
 */

import {
    buryExhaustedStaleJobs,
    type ClaimedAsyncJob,
    claimDueJobs,
    completeJob,
    countPendingJobs,
    failJobAttempt,
    heartbeatJob,
    pruneFinishedJobs,
    reclaimStaleJobs,
    releaseClaimedJobs,
} from "@/db/queries/async-jobs";
import { captureServerException } from "@/lib/posthog-server";
import { backoffDelayMs } from "./backoff";
import { setJobTicker } from "./nudge";
import { listJobHandlers } from "./registry";
import {
    describeJobError,
    isRetryableError,
    JobAbortedError,
    JobTimeoutError,
} from "./retryable";
import type { JobHandler, JobProgress } from "./types";

/**
 * How often the queue is swept.
 *
 * Short, because a user waiting on a summary they just asked for sees this
 * interval as dead time before anything happens. `nudge()` below removes it
 * for the common case; this is the floor for work enqueued by another
 * process, and for anything a restart left behind.
 */
const TICK_MS = 5_000;

/**
 * How long a claimed job may go without a heartbeat before another worker may
 * take it.
 *
 * Generous relative to `HEARTBEAT_MS`: a garbage-collection pause, a slow
 * database or a busy event loop can all delay a beat, and reclaiming a job
 * that is merely late means running it twice. Ten missed beats is not late.
 */
const STALE_MS = 120_000;
const HEARTBEAT_MS = 12_000;

/** Finished rows are bookkeeping, not history. */
const FINISHED_RETENTION_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const MAX_PRUNE_PER_TICK = 200;

/** Default wait between attempts when a handler does not set its own. */
const DEFAULT_JOB_BACKOFF = { baseMs: 20_000, maxMs: 10 * 60_000, jitter: 0.3 };

const inFlight = new Map<string, Promise<void>>();
const inFlightByKind = new Map<string, number>();
/**
 * Claims this process is currently holding. Keyed by job id, valued by claim
 * token -- everything the queue does with a claim is token-scoped. Exposed by
 * `heldClaims()` for a caller able to hand them back on the way out.
 */
const claimsHeld = new Map<string, string>();

function countInFlight(kind: string): number {
    return inFlightByKind.get(kind) ?? 0;
}

/**
 * Run one claimed job to a terminal state.
 *
 * Every exit path writes the row exactly once, scoped to the claim token, so
 * a job reclaimed mid-run cannot be written over by the worker that lost it.
 */
async function runJob(
    job: ClaimedAsyncJob,
    handler: JobHandler<unknown>,
): Promise<void> {
    const controller = new AbortController();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (timeout) clearTimeout(timeout);
    };

    try {
        const payload = handler.parsePayload(job.payload ?? {});

        // The heartbeat doubles as an ownership check. If the row says the
        // claim is no longer ours -- reclaimed while this process was
        // unresponsive, or the job was deleted -- there is another worker on
        // it now, and continuing would mean two runs of the same work.
        heartbeat = setInterval(() => {
            void heartbeatJob(job.id, job.claimToken)
                .then((stillOurs) => {
                    if (!stillOurs) {
                        controller.abort(
                            new JobAbortedError(
                                "Claim was taken over by another worker",
                            ),
                        );
                    }
                })
                .catch(() => {
                    // A failed heartbeat is not evidence of anything. Losing
                    // the claim needs `STALE_MS` of silence, and one blip is
                    // far short of that.
                });
        }, HEARTBEAT_MS);
        heartbeat.unref?.();

        const timedOut = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
                const error = new JobTimeoutError(
                    handler.kind,
                    handler.timeoutMs,
                );
                controller.abort(error);
                reject(error);
            }, handler.timeoutMs);
            timeout.unref?.();
        });

        const reportProgress = (progress: JobProgress) => {
            // Fire-and-forget, and swallowing its own failure: progress is a
            // convenience for whoever is watching, and a job that succeeded
            // must not be failed because one status write did not land.
            void heartbeatJob(job.id, job.claimToken, {
                ...progress,
                at: new Date().toISOString(),
            }).catch(() => {});
        };

        // `Promise.race`, not an abort the handler is trusted to honour: a
        // handler that ignores its signal would otherwise hold a worker slot
        // forever. The losing side is abandoned rather than stopped, so a
        // timed-out handler may still finish its own work later -- harmless
        // for handlers that write idempotently (the summary handler upserts),
        // and the job row itself is safe either way because every write to it
        // is claim-scoped.
        const result = await Promise.race([
            handler.run({
                jobId: job.id,
                userId: job.userId,
                attempt: job.attempts,
                maxAttempts: job.maxAttempts,
                payload,
                signal: controller.signal,
                reportProgress,
            }),
            timedOut,
        ]);

        stop();
        await completeJob({
            jobId: job.id,
            claimToken: job.claimToken,
            result: result ?? null,
        });
    } catch (error) {
        stop();
        const retryable = (handler.isRetryable ?? isRetryableError)(error);
        const { message, code } = describeJobError(error);
        const delayMs = backoffDelayMs(job.attempts, {
            ...DEFAULT_JOB_BACKOFF,
            ...handler.backoff,
        });

        const outcome = await failJobAttempt({
            jobId: job.id,
            claimToken: job.claimToken,
            message,
            code,
            retryable,
            delayMs,
        }).catch((writeError) => {
            // Nothing left to do but say so: the job stays `processing` and
            // the stale reclaim will pick it up.
            console.error(
                `[job-worker] could not record failure for job ${job.id}:`,
                writeError,
            );
            return null;
        });

        if (outcome === null) {
            console.warn(
                `[job-worker] job ${job.id} (${job.kind}) failed but its claim was superseded; not recording`,
            );
        } else if (outcome.status === "failed") {
            console.error(
                `[job-worker] job ${job.id} (${job.kind}) failed permanently after ${outcome.attempts} attempt(s):`,
                error,
            );
            // Only the terminal failure is reported. A retried attempt is
            // noise -- the job may well succeed on the next one.
            captureServerException(error, {
                source: `worker:job:${job.kind}`,
                distinctId: job.userId,
                attempts: outcome.attempts,
            });
        } else {
            console.warn(
                `[job-worker] job ${job.id} (${job.kind}) attempt ${outcome.attempts}/${job.maxAttempts} failed, retrying in ${Math.round(delayMs / 1000)}s: ${message}`,
            );
        }
    } finally {
        stop();
    }
}

function track(job: ClaimedAsyncJob, handler: JobHandler<unknown>): void {
    inFlightByKind.set(job.kind, countInFlight(job.kind) + 1);
    claimsHeld.set(job.id, job.claimToken);
    const promise = runJob(job, handler)
        .catch((error) => {
            // `runJob` handles its own failures; reaching here means the
            // bookkeeping itself threw, which must not take the worker down.
            console.error(
                `[job-worker] unhandled error in job ${job.id}:`,
                error,
            );
        })
        .finally(() => {
            inFlight.delete(job.id);
            claimsHeld.delete(job.id);
            inFlightByKind.set(
                job.kind,
                Math.max(0, countInFlight(job.kind) - 1),
            );
        });
    inFlight.set(job.id, promise);
}

let ticking = false;
let lastPruneAt = 0;

/** Exported for testing. */
export async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
        const reclaimed = await reclaimStaleJobs(STALE_MS);
        if (reclaimed > 0) {
            console.log(
                `[job-worker] reclaimed ${reclaimed} job(s) from workers that stopped responding`,
            );
        }
        const buried = await buryExhaustedStaleJobs(STALE_MS);
        if (buried > 0) {
            console.warn(
                `[job-worker] buried ${buried} job(s) that exhausted their attempts without reporting`,
            );
        }

        for (const handler of listJobHandlers()) {
            const slots = handler.concurrency - countInFlight(handler.kind);
            if (slots <= 0) continue;
            const claimed = await claimDueJobs(handler.kind, slots);
            for (const job of claimed) {
                track(job, handler);
            }
        }

        if (Date.now() - lastPruneAt >= PRUNE_EVERY_MS) {
            lastPruneAt = Date.now();
            const pruned = await pruneFinishedJobs(
                FINISHED_RETENTION_MS,
                MAX_PRUNE_PER_TICK,
            );
            if (pruned > 0) {
                console.log(`[job-worker] pruned ${pruned} finished job(s)`);
            }
        }
    } catch (error) {
        console.error("[job-worker] tick failed:", error);
        captureServerException(error, { source: "worker:jobs" });
    } finally {
        ticking = false;
    }
}

/** Exported for testing: settle everything currently running. */
export async function waitForIdle(): Promise<void> {
    while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight.values()]);
    }
}

/**
 * Hand claimed jobs straight back to the queue instead of waiting out the
 * stale threshold.
 *
 * Nothing calls this automatically, and that is a deliberate choice rather
 * than an omission. The obvious caller would be a `SIGTERM` handler -- a
 * deploy is the common way a job gets interrupted, and releasing on the way
 * out would let the replacement instance pick the work up at once rather than
 * two minutes later. But installing a listener for `SIGTERM` REMOVES Node's
 * default behaviour of exiting on it, and this app is `exec bun server.js` as
 * PID 1 with no other handler: getting that wrong means the container ignores
 * `SIGTERM` and is `SIGKILL`ed after the grace period on every single deploy.
 * A container that will not stop is a far worse bug than a summary that
 * restarts two minutes later, and `reclaimStaleJobs` already delivers the
 * guarantee on its own.
 *
 * So this exists for a caller that can shut down safely -- a worker run as its
 * own process, or a runtime with a real shutdown hook -- and for the tests
 * that pin what a release does: unlike a reclaim, it REFUNDS the attempt,
 * because being interrupted by a deploy is not the job's fault.
 */
export async function releaseInFlightJobs(
    jobs: { jobId: string; claimToken: string }[],
): Promise<void> {
    if (jobs.length === 0) return;
    try {
        const released = await releaseClaimedJobs(jobs);
        if (released > 0) {
            console.log(
                `[job-worker] released ${released} in-flight job(s) back to the queue for the next instance`,
            );
        }
    } catch (error) {
        // Best effort. The stale reclaim is the backstop and needs nothing
        // from us, so a failure here costs latency, never the job.
        console.error("[job-worker] failed to release in-flight jobs:", error);
    }
}

/** Claims this process currently holds, for a caller able to release them. */
export function heldClaims(): { jobId: string; claimToken: string }[] {
    return [...claimsHeld.entries()].map(([jobId, claimToken]) => ({
        jobId,
        claimToken,
    }));
}

let started = false;

/**
 * Start the generic job worker. Safe to call more than once.
 *
 * Runs on hosted and self-host alike: unattended work that vanishes on
 * restart is worse for a self-hosted single container -- which is restarted
 * by hand, often -- than for a managed fleet.
 */
export function startJobWorker(): void {
    if (started) return;
    started = true;

    const interval = setInterval(() => {
        void tick();
    }, TICK_MS);
    interval.unref?.();

    // Lets `enqueueJob` callers start their work immediately instead of
    // waiting out `TICK_MS`, without having to import this module.
    setJobTicker(() => {
        void tick();
    });

    // No signal handler here on purpose -- see `releaseInFlightJobs`. A
    // process killed mid-job is recovered by `reclaimStaleJobs` instead, which
    // needs nothing from the dying process to work.

    void countPendingJobs()
        .then((pending) => {
            if (pending > 0) {
                console.log(
                    `[job-worker] starting with ${pending} job(s) already queued`,
                );
            }
        })
        .catch(() => {});

    void tick();
}

/** Exported for testing. Resets module state between cases. */
export function __resetJobWorkerForTests(): void {
    started = false;
    ticking = false;
    lastPruneAt = 0;
    inFlight.clear();
    inFlightByKind.clear();
    claimsHeld.clear();
}
