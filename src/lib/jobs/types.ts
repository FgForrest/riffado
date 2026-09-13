/**
 * The contract a durable background operation implements.
 *
 * Keeping this separate from the worker is what makes a second kind of job
 * cheap: a handler is a plain object with a `run` function, testable on its
 * own, and the worker supplies claiming, retries, heartbeating, timeouts and
 * reclaim-after-restart identically for every kind.
 */

import type { BackoffOptions } from "./backoff";

/**
 * A progress snapshot, stored on the job row and read back by any client
 * watching it.
 *
 * Counts and phase names only. The row is not encrypted (see the comment on
 * `asyncJobs` in the schema), so nothing derived from a transcript, a prompt
 * or a summary may go in here.
 */
export interface JobProgress {
    /** Short machine-ish name for the current stage, e.g. "passes". */
    phase: string;
    /** Units finished, when the work has countable units. */
    completed?: number;
    /** Units expected. */
    total?: number;
}

export interface JobContext<P> {
    jobId: string;
    userId: string;
    /** 1-based. A handler can behave differently on a retry if it wants to. */
    attempt: number;
    maxAttempts: number;
    payload: P;
    /**
     * Aborted when the attempt runs past its handler's `timeoutMs`, when the
     * worker is shutting down, or when the job is reclaimed by another
     * process. A handler doing anything long should pass it to `fetch` and
     * check it between steps -- ignoring it only means the work continues
     * pointlessly, not that it is counted.
     */
    signal: AbortSignal;
    /**
     * Publish progress. Fire-and-forget: it also serves as the job's
     * heartbeat, but it never throws and never blocks the handler, so a
     * database blip cannot fail work that is otherwise succeeding.
     */
    reportProgress: (progress: JobProgress) => void;
}

/**
 * What a handler returns, stored as the job's `result`.
 *
 * Provenance, not output. A handler that produces content writes it to its
 * own encrypted home and returns a description of what it did -- see the
 * summary handler, which persists through `upsertEnhancement` and returns
 * only counts and the provider it used.
 */
export type JobResult = Record<string, unknown>;

export interface JobHandler<P = unknown> {
    /** Stored verbatim in `async_jobs.kind`. Max 64 chars. */
    kind: string;
    /**
     * How many jobs of this kind one worker process runs at once.
     *
     * This is a resource budget, not a throughput dial. Multi-pass
     * summarisation fans out to N concurrent provider calls per job, and
     * against the agent bridge (`BRIDGE_MAX_CONCURRENCY`) a second concurrent
     * job does not run twice as fast -- it makes both queue behind the same
     * limit while looking, from the outside, like two stalled jobs.
     */
    concurrency: number;
    /** Attempts a job of this kind gets, counted from its first claim. */
    maxAttempts: number;
    /**
     * Ceiling on a single attempt. Past it the context's signal is aborted
     * and the attempt fails as a timeout (retryable), so a wedged provider
     * call cannot hold a worker slot indefinitely.
     */
    timeoutMs: number;
    /** Wait between attempts of a job of this kind. */
    backoff?: Partial<BackoffOptions>;
    /**
     * Validate and narrow the stored jsonb payload.
     *
     * Throws on anything it does not recognise, which the worker treats as
     * permanent: a payload that does not parse will not parse on a retry
     * either. This is also the boundary that stops a row written by an older
     * (or newer) deploy from reaching handler code that assumes otherwise.
     */
    parsePayload: (raw: Record<string, unknown>) => P;
    // biome-ignore lint/suspicious/noConfusingVoidType: a handler whose work leaves nothing worth recording should be able to simply not return, rather than be made to write `return undefined` to satisfy the type.
    run: (ctx: JobContext<P>) => Promise<JobResult | void>;
    /**
     * Override the shared classifier in `retryable.ts` when a kind knows
     * something about its own failures that the generic mapping cannot.
     */
    isRetryable?: (error: unknown) => boolean;
}

/** Thrown by `parsePayload` implementations; always permanent. */
export class InvalidJobPayloadError extends Error {
    constructor(kind: string, detail: string) {
        super(`Invalid payload for job kind "${kind}": ${detail}`);
        this.name = "InvalidJobPayloadError";
    }
}
