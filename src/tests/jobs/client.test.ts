/**
 * Following a job from the browser.
 *
 * This is the code that decides what a user is told when their connection
 * dies mid-summary. Before the queue the only honest answer was
 * "interrupted"; now the work outlives the request, so the interesting cases
 * are the ones where this must NOT invent a verdict -- a flaky network, an
 * unmounted component, a job it cannot see.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { followJob, isTerminalJobStatus } from "@/lib/jobs/client";

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as Response;
}

const noSleep = async () => {};

describe("isTerminalJobStatus", () => {
    it("treats only completed and failed as final", () => {
        expect(isTerminalJobStatus("completed")).toBe(true);
        expect(isTerminalJobStatus("failed")).toBe(true);
        expect(isTerminalJobStatus("pending")).toBe(false);
        expect(isTerminalJobStatus("processing")).toBe(false);
    });
});

describe("followJob", () => {
    beforeEach(() => vi.clearAllMocks());

    it("polls until the job settles and returns the final snapshot", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse({ id: "job-1", status: "processing" }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    id: "job-1",
                    status: "completed",
                    result: { provider: "openai" },
                }),
            );

        const snapshot = await followJob("job-1", {
            fetchImpl,
            sleep: noSleep,
        });

        expect(snapshot).toMatchObject({ status: "completed" });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0][0]).toBe("/api/jobs/job-1");
    });

    it("returns the failure rather than throwing it", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            jsonResponse({
                id: "job-1",
                status: "failed",
                error: "No AI provider configured",
            }),
        );

        const snapshot = await followJob("job-1", {
            fetchImpl,
            sleep: noSleep,
        });

        // The caller shows this message; a thrown error would collapse a
        // specific, actionable failure into a generic one.
        expect(snapshot).toMatchObject({
            status: "failed",
            error: "No AI provider configured",
        });
    });

    it("stops immediately on a job it cannot see", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 404));

        const snapshot = await followJob("job-1", {
            fetchImpl,
            sleep: noSleep,
        });

        // Pruned, or never this user's. No amount of polling produces it, and
        // null means "unknown" rather than "failed".
        expect(snapshot).toBeNull();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("rides out a network blip instead of giving up on the job", async () => {
        const fetchImpl = vi
            .fn()
            .mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockResolvedValueOnce(jsonResponse({}, 502))
            .mockResolvedValueOnce(
                jsonResponse({ id: "job-1", status: "completed" }),
            );

        const snapshot = await followJob("job-1", {
            fetchImpl,
            sleep: noSleep,
        });

        // The reason this code runs at all is usually a connection that has
        // just proven unreliable, so one more failure is not news.
        expect(snapshot).toMatchObject({ status: "completed" });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("reports each distinct progress snapshot once", async () => {
        const onProgress = vi.fn();
        const progress = { phase: "passes", completed: 1, total: 3 };
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                jsonResponse({ id: "j", status: "processing", progress }),
            )
            .mockResolvedValueOnce(
                jsonResponse({ id: "j", status: "processing", progress }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    id: "j",
                    status: "completed",
                    progress: { phase: "merging", completed: 3, total: 3 },
                }),
            );

        await followJob("j", { fetchImpl, sleep: noSleep, onProgress });

        // Compared by value: every poll deserialises a fresh object, so an
        // identity check would report movement on every single tick.
        expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it("stops without another request once aborted", async () => {
        const controller = new AbortController();
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(jsonResponse({ id: "j", status: "processing" }));

        const snapshot = await followJob("j", {
            fetchImpl,
            // An unmounting component should not make one more request on its
            // way out, nor keep polling a page nobody is looking at.
            sleep: async () => controller.abort(),
            signal: controller.signal,
        });

        expect(snapshot).toBeNull();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("makes no request at all when aborted before it starts", async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchImpl = vi.fn();

        expect(
            await followJob("j", {
                fetchImpl,
                sleep: noSleep,
                signal: controller.signal,
            }),
        ).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
