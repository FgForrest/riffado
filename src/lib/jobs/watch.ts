/**
 * Follow a job from outside the worker.
 *
 * Once generation moved onto a worker, a request that wants to report
 * progress can no longer observe it directly -- the job may well be running
 * in a different process. Polling the row is what works in every case: same
 * process, another instance, or a worker that has since been replaced by a
 * restart.
 *
 * Deliberately not an in-process event bus. One mechanism that is always
 * correct beats a fast path plus a fallback that is only exercised when
 * something has already gone wrong, and a poll interval of a second is far
 * below the cadence of real progress -- a summary pass takes tens of seconds.
 */

import {
    type AsyncJobRow,
    type AsyncJobStatus,
    getJobForUser,
} from "@/db/queries/async-jobs";

const TERMINAL: ReadonlySet<AsyncJobStatus> = new Set(["completed", "failed"]);

export function isTerminalStatus(status: AsyncJobStatus): boolean {
    return TERMINAL.has(status);
}

export interface WatchJobOptions {
    pollMs?: number;
    /**
     * Stop watching after this long and return the row as it stands. The
     * caller can then tell the client to keep polling on its own -- the job
     * itself is unaffected either way.
     */
    timeoutMs?: number;
    /**
     * Called when the job's progress snapshot changes, and once with whatever
     * progress already exists when watching starts -- a client reattaching to
     * a job that is halfway through should not have to wait for the next
     * change to find out where it is.
     */
    onProgress?: (progress: Record<string, unknown>, row: AsyncJobRow) => void;
    /** Called on every poll, whether or not anything changed. For keep-alives. */
    onPoll?: (row: AsyncJobRow | null) => void;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

export interface WatchJobResult {
    /** Null when the job disappeared (pruned, or the recording was deleted). */
    row: AsyncJobRow | null;
    /** Why watching stopped. */
    reason: "settled" | "timeout" | "aborted" | "missing";
}

const defaultSleep = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

/** Default poll cadence. See the module comment for why this is not faster. */
export const DEFAULT_JOB_POLL_MS = 1_000;

/**
 * Poll a job until it settles, the deadline passes, or the caller aborts.
 *
 * The very first read happens before any sleep, so a job that finished
 * between being enqueued and being watched is reported immediately rather
 * than after a pointless wait.
 */
export async function watchJob(
    jobId: string,
    userId: string,
    opts: WatchJobOptions = {},
): Promise<WatchJobResult> {
    const pollMs = opts.pollMs ?? DEFAULT_JOB_POLL_MS;
    const sleep = opts.sleep ?? defaultSleep;
    const now = opts.now ?? Date.now;
    const deadline =
        opts.timeoutMs === undefined ? null : now() + opts.timeoutMs;

    let lastProgress: string | null = null;

    for (;;) {
        if (opts.signal?.aborted) return { row: null, reason: "aborted" };

        const row = await getJobForUser(jobId, userId);
        opts.onPoll?.(row);

        if (!row) return { row: null, reason: "missing" };

        if (row.progress) {
            // Compared by value, not identity: every poll returns a freshly
            // deserialised object, so an identity check would report a change
            // on every single tick.
            const serialised = JSON.stringify(row.progress);
            if (serialised !== lastProgress) {
                lastProgress = serialised;
                opts.onProgress?.(row.progress, row);
            }
        }

        if (isTerminalStatus(row.status)) return { row, reason: "settled" };
        if (deadline !== null && now() >= deadline) {
            return { row, reason: "timeout" };
        }

        await sleep(pollMs);
    }
}
