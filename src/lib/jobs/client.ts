/**
 * Following a job from the browser.
 *
 * BROWSER-SAFE. Nothing else in `src/lib/jobs/` is -- the worker, the queue
 * and the handlers all reach the database -- so this file must keep to
 * `fetch` and plain types, the same rule `summary/progress-stream.ts` follows
 * for the same reason.
 *
 * It exists because a summary now outlives the request that asked for it. The
 * event stream can end for reasons that have nothing to do with the work: a
 * closed laptop, a proxy's idle timeout, a deploy. Before the queue there was
 * nothing to say whether the summary had died with the connection, so the
 * honest report was "interrupted". Now there is a job id, and the truthful
 * answer is almost always "still running" -- this is what goes and finds out.
 */

export type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface JobProgressSnapshot {
    phase: string;
    completed?: number;
    total?: number;
}

export interface JobSnapshot {
    id: string;
    kind: string;
    status: JobStatus;
    attempts: number;
    maxAttempts: number;
    progress: JobProgressSnapshot | null;
    result: Record<string, unknown> | null;
    error: string | null;
    errorCode: string | null;
}

export function isTerminalJobStatus(status: JobStatus): boolean {
    return status === "completed" || status === "failed";
}

export interface FollowJobOptions {
    pollMs?: number;
    onProgress?: (progress: JobProgressSnapshot) => void;
    signal?: AbortSignal;
    /** Injected in tests. */
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Slower than the server's own watch loop.
 *
 * This only runs once a connection has already failed, often on a tab nobody
 * is looking at, and progress moves on the order of tens of seconds. Polling
 * hard would buy nothing and cost every reconnecting client a request a
 * second.
 */
export const FOLLOW_POLL_MS = 2_500;

const defaultSleep = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Poll a job until it settles, disappears, or the caller aborts.
 *
 * Returns the final snapshot, or null if the job could not be followed -- a
 * 404 (pruned, or never the caller's to see), an abort, or a network that
 * stays down. A null is deliberately not an error: it means "unknown", and a
 * caller should say so rather than claim the work failed.
 *
 * Transient fetch failures are swallowed and retried on the next tick, since
 * the reason we are here at all is usually a connection that has just proven
 * itself unreliable.
 */
export async function followJob(
    jobId: string,
    opts: FollowJobOptions = {},
): Promise<JobSnapshot | null> {
    const pollMs = opts.pollMs ?? FOLLOW_POLL_MS;
    const sleep = opts.sleep ?? defaultSleep;
    const doFetch = opts.fetchImpl ?? fetch;
    let lastProgress: string | null = null;

    for (;;) {
        if (opts.signal?.aborted) return null;

        let snapshot: JobSnapshot | null = null;
        try {
            const response = await doFetch(`/api/jobs/${jobId}`, {
                signal: opts.signal,
            });
            // A job that is gone is gone: it was pruned, or it never belonged
            // to this user. Either way no amount of polling will produce it.
            if (response.status === 404) return null;
            if (response.ok) {
                snapshot = (await response.json()) as JobSnapshot;
            }
        } catch {
            // Network blip. Fall through to the wait and try again.
        }

        if (snapshot) {
            if (snapshot.progress) {
                const serialised = JSON.stringify(snapshot.progress);
                if (serialised !== lastProgress) {
                    lastProgress = serialised;
                    opts.onProgress?.(snapshot.progress);
                }
            }
            if (isTerminalJobStatus(snapshot.status)) return snapshot;
        }

        await sleep(pollMs);
        // Re-checked after the wait, so an unmounting component stops here
        // rather than making one more request on its way out.
        if (opts.signal?.aborted) return null;
    }
}
