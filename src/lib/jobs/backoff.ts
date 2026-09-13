/**
 * Exponential backoff with jitter, and the in-attempt retry helper built on
 * it.
 *
 * Two different things use this, at two different scales:
 *
 *   - A handler retrying one provider call it just made (seconds). A 429 on
 *     one of three summary passes should cost a short wait, not the other two
 *     passes' tokens -- those already succeeded and re-running the whole job
 *     would pay for them again.
 *   - The worker rescheduling a whole job that failed (seconds to minutes).
 *
 * Pure, and both the clock and the randomness are injectable, so the tests
 * assert on real schedules rather than sleeping through them.
 */

export interface BackoffOptions {
    /** Delay before the first retry. Doubles each subsequent attempt. */
    baseMs: number;
    /** Ceiling on a single delay, before jitter. */
    maxMs: number;
    /**
     * Fraction of the computed delay that is randomised away, 0..1. At 0.5 a
     * nominal 4s wait lands somewhere in 2-4s.
     *
     * This is not decoration. Multi-pass fires N identical requests at the
     * same instant, so when a provider rate-limits it they are all rejected at
     * the same instant too -- and without jitter they would all retry at the
     * same instant, reproducing the burst that caused the problem. The same
     * applies across processes when a provider outage fails every worker's
     * jobs together.
     */
    jitter?: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
    baseMs: 1_000,
    maxMs: 30_000,
    jitter: 0.5,
};

/**
 * Delay before retry number `attempt` (1-based: `attempt` 1 is the wait after
 * the first failure).
 */
export function backoffDelayMs(
    attempt: number,
    opts: BackoffOptions = DEFAULT_BACKOFF,
    random: () => number = Math.random,
): number {
    const n = Math.max(1, Math.floor(attempt));
    // 2**n overflows to Infinity long before it matters, but `maxMs` is
    // applied first so the result stays finite regardless of how large a
    // caller's attempt counter has grown.
    const exponential = Math.min(opts.maxMs, opts.baseMs * 2 ** (n - 1));
    const jitter = Math.min(Math.max(opts.jitter ?? 0, 0), 1);
    if (jitter === 0) return Math.round(exponential);
    const floor = exponential * (1 - jitter);
    return Math.round(floor + random() * (exponential - floor));
}

export interface RetryOptions<T> extends Partial<BackoffOptions> {
    /** Total attempts including the first. `1` disables retrying. */
    attempts: number;
    /**
     * Decides whether a given rejection is worth waiting on. Anything that
     * cannot succeed on a retry -- a malformed request, a missing credential,
     * a transcript past the model's context window -- must return false, or
     * the caller pays for the same failure several times over and the user
     * waits through all of it.
     */
    isRetryable: (error: unknown) => boolean;
    /** Called before each wait. For logging; never throws into the retry. */
    onRetry?: (info: {
        attempt: number;
        delayMs: number;
        error: unknown;
    }) => void;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    /** Aborts the retry loop between attempts. */
    signal?: AbortSignal;
    run: () => Promise<T>;
}

const defaultSleep = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Run `run`, retrying retryable rejections with backoff.
 *
 * Rethrows the LAST error rather than the first: by the time attempts are
 * exhausted, the most recent failure is the one that describes the state the
 * caller is actually in.
 */
export async function retryWithBackoff<T>(opts: RetryOptions<T>): Promise<T> {
    const total = Math.max(1, Math.floor(opts.attempts));
    const backoff: BackoffOptions = {
        baseMs: opts.baseMs ?? DEFAULT_BACKOFF.baseMs,
        maxMs: opts.maxMs ?? DEFAULT_BACKOFF.maxMs,
        jitter: opts.jitter ?? DEFAULT_BACKOFF.jitter,
    };
    const sleep = opts.sleep ?? defaultSleep;

    let lastError: unknown;
    for (let attempt = 1; attempt <= total; attempt += 1) {
        try {
            return await opts.run();
        } catch (error) {
            lastError = error;
            const isLast = attempt === total;
            if (isLast || !opts.isRetryable(error)) throw error;
            if (opts.signal?.aborted) throw error;
            const delayMs = backoffDelayMs(attempt, backoff, opts.random);
            opts.onRetry?.({ attempt, delayMs, error });
            await sleep(delayMs);
            // Re-checked after the wait: the job may have been cancelled or
            // the worker asked to stop while we were sleeping, and spending
            // another provider call on it then is pure waste.
            if (opts.signal?.aborted) throw error;
        }
    }
    throw lastError;
}
