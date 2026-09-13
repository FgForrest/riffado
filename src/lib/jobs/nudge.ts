/**
 * "Sweep the queue now" without depending on the worker.
 *
 * Enqueueing code wants to say "and please start it", but it should not have
 * to import the worker to do so -- that would drag the whole queue runtime,
 * PostHog and the database config into every module that merely queues
 * something, and into every test of one.
 *
 * So the worker registers its tick here at startup, and enqueueing code calls
 * `nudge()`. When no worker is running in this process -- a test, a build, a
 * deployment that runs the web tier separately -- this is a no-op and the
 * job is simply picked up by whichever process is sweeping.
 */

let ticker: (() => void) | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounce window. Long enough that a sync enqueueing a dozen recordings
 * schedules one sweep rather than a dozen, short enough to be invisible to
 * someone who just clicked a button.
 */
const NUDGE_DEBOUNCE_MS = 50;

/** Called by the worker at startup. */
export function setJobTicker(fn: (() => void) | null): void {
    ticker = fn;
}

/** Ask the local worker, if there is one, to sweep now instead of on schedule. */
export function nudge(): void {
    if (!ticker || pending) return;
    pending = setTimeout(() => {
        pending = null;
        ticker?.();
    }, NUDGE_DEBOUNCE_MS);
    pending.unref?.();
}

/** Test seam. */
export function __resetNudgeForTests(): void {
    if (pending) clearTimeout(pending);
    pending = null;
    ticker = null;
}
