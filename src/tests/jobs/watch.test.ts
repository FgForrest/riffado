/**
 * Following a job from a request.
 *
 * The polling is deliberate (see the module comment on `watch.ts`), which
 * makes the loop's edges the thing to pin: when it reads, when it reports a
 * change, and -- most importantly -- how it distinguishes "the job failed"
 * from "the job is still going". Confusing those two is how a user gets told
 * their summary died while a worker is busy producing it.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/db/queries/async-jobs", () => ({ getJobForUser: vi.fn() }));

import { getJobForUser } from "@/db/queries/async-jobs";
import { isTerminalStatus, watchJob } from "@/lib/jobs/watch";

type Row = Record<string, unknown>;

/** Return each row in turn on successive polls, repeating the last one. */
function poll(rows: (Row | null)[]) {
    let index = 0;
    (getJobForUser as Mock).mockImplementation(async () => {
        const row = rows[Math.min(index, rows.length - 1)];
        index += 1;
        return row;
    });
}

const noSleep = async () => {};

describe("isTerminalStatus", () => {
    it("treats only completed and failed as final", () => {
        expect(isTerminalStatus("completed")).toBe(true);
        expect(isTerminalStatus("failed")).toBe(true);
        expect(isTerminalStatus("pending")).toBe(false);
        expect(isTerminalStatus("processing")).toBe(false);
    });
});

describe("watchJob", () => {
    beforeEach(() => vi.clearAllMocks());

    it("reads once before sleeping at all", async () => {
        const sleep = vi.fn(noSleep);
        poll([{ id: "job-1", status: "completed", progress: null }]);

        const result = await watchJob("job-1", "user-1", { sleep });

        expect(result.reason).toBe("settled");
        // A job that finished between being queued and being watched should
        // be reported straight away, not after a pointless wait.
        expect(sleep).not.toHaveBeenCalled();
    });

    it("keeps polling until the job reaches a terminal state", async () => {
        poll([
            { id: "job-1", status: "pending", progress: null },
            { id: "job-1", status: "processing", progress: null },
            { id: "job-1", status: "completed", progress: null },
        ]);

        const result = await watchJob("job-1", "user-1", { sleep: noSleep });

        expect(result.reason).toBe("settled");
        expect(result.row).toMatchObject({ status: "completed" });
        expect(getJobForUser).toHaveBeenCalledTimes(3);
    });

    it("reports each distinct progress snapshot exactly once", async () => {
        const onProgress = vi.fn();
        poll([
            {
                id: "job-1",
                status: "processing",
                progress: { phase: "passes", completed: 1, total: 3 },
            },
            // The same snapshot again: the job has not moved, and reporting it
            // twice would make a stalled run look like a progressing one.
            {
                id: "job-1",
                status: "processing",
                progress: { phase: "passes", completed: 1, total: 3 },
            },
            {
                id: "job-1",
                status: "completed",
                progress: { phase: "merging", completed: 3, total: 3 },
            },
        ]);

        await watchJob("job-1", "user-1", { sleep: noSleep, onProgress });

        expect(onProgress).toHaveBeenCalledTimes(2);
        expect(onProgress.mock.calls[0][0]).toMatchObject({ completed: 1 });
        expect(onProgress.mock.calls[1][0]).toMatchObject({
            phase: "merging",
        });
    });

    it("reports progress that already exists when watching starts", async () => {
        // A client reattaching halfway through should see where the job is,
        // not wait for the next change to find out.
        const onProgress = vi.fn();
        poll([
            {
                id: "job-1",
                status: "completed",
                progress: { phase: "merging", completed: 3, total: 3 },
            },
        ]);

        await watchJob("job-1", "user-1", { sleep: noSleep, onProgress });

        expect(onProgress).toHaveBeenCalledTimes(1);
    });

    it("gives up at the deadline and hands back the row as it stands", async () => {
        let now = 0;
        poll([{ id: "job-1", status: "processing", progress: null }]);

        const result = await watchJob("job-1", "user-1", {
            sleep: async () => {
                now += 1_000;
            },
            now: () => now,
            timeoutMs: 3_000,
        });

        // Not "failed" -- the job is still running, and the caller needs to
        // be able to tell the difference.
        expect(result.reason).toBe("timeout");
        expect(result.row).toMatchObject({ status: "processing" });
    });

    it("reports a job that is not there", async () => {
        poll([null]);
        const result = await watchJob("job-1", "user-1", { sleep: noSleep });
        expect(result).toEqual({ row: null, reason: "missing" });
    });

    it("stops when the caller aborts", async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await watchJob("job-1", "user-1", {
            sleep: noSleep,
            signal: controller.signal,
        });

        expect(result.reason).toBe("aborted");
        expect(getJobForUser).not.toHaveBeenCalled();
    });

    it("calls back on every poll, so a caller can keep a connection warm", async () => {
        const onPoll = vi.fn();
        poll([
            { id: "job-1", status: "processing", progress: null },
            { id: "job-1", status: "processing", progress: null },
            { id: "job-1", status: "completed", progress: null },
        ]);

        await watchJob("job-1", "user-1", { sleep: noSleep, onPoll });

        // Unlike `onProgress`, this fires whether or not anything changed --
        // which is the point, since a silent stream is what proxies close.
        expect(onPoll).toHaveBeenCalledTimes(3);
    });
});
