/**
 * The summary job handler.
 *
 * Two things moved when generation left the request, and both are here.
 *
 * `summary.completed` used to be emitted by the transcription pipeline right
 * after an inline call. It now comes from the handler, because that is the
 * only place that still knows the summary has actually been written -- a
 * subscriber receiving that event and finding no summary would be worse than
 * receiving it late.
 *
 * And `summary.failed` must not fire on an attempt that is going to be
 * retried. Telling a subscriber the summary failed and then having it succeed
 * a minute later is a worse story than telling them once, at the end.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// The handler shares its constants and payload parser with the enqueue side,
// which owns a database client. Nothing here queues anything.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/summary/generate-summary", () => ({
    generateSummaryForRecording: vi.fn(),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

import { AppError, ErrorCode } from "@/lib/errors";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import { emitEvent } from "@/lib/webhooks/emit";

function context(overrides: Record<string, unknown> = {}) {
    return {
        jobId: "job-1",
        userId: "user-1",
        attempt: 1,
        maxAttempts: 3,
        payload: { recordingId: "rec-1", trigger: "manual" as const },
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
        ...overrides,
    };
}

const generated = {
    // Distinctive enough that finding it anywhere in the job's result means
    // it genuinely leaked, rather than colliding with a JSON key.
    summary: "CONFIDENTIAL_SUMMARY_PROSE",
    keyPoints: ["CONFIDENTIAL_KEY_POINT"],
    actionItems: [],
    provider: "openai",
    model: "gpt-4o-mini",
    promptId: "general",
    promptFallback: false,
};

describe("summaryJobHandler", () => {
    beforeEach(() => vi.clearAllMocks());

    it("declares one job at a time", () => {
        // A multi-pass job already fans out to N concurrent provider calls.
        // A second concurrent job does not double throughput against a bridge
        // with its own concurrency limit -- it makes both look stalled.
        expect(summaryJobHandler.concurrency).toBe(1);
    });

    it("returns provenance and never the summary itself", async () => {
        (generateSummaryForRecording as Mock).mockResolvedValue({
            ...generated,
            multiPass: { roundsRequested: 3, passesUsed: 3, merged: true },
        });

        const result = await summaryJobHandler.run(context());

        expect(result).toEqual({
            provider: "openai",
            model: "gpt-4o-mini",
            promptId: "general",
            promptFallback: false,
            multiPass: { roundsRequested: 3, passesUsed: 3, merged: true },
        });
        // The job row is not encrypted, unlike `ai_enhancements`. Putting the
        // summary text on it would be a plaintext copy of content that is
        // encrypted everywhere else.
        expect(JSON.stringify(result)).not.toContain(generated.summary);
        expect(JSON.stringify(result)).not.toContain(generated.keyPoints[0]);
    });

    it("omits multiPass entirely for a single-pass run", async () => {
        (generateSummaryForRecording as Mock).mockResolvedValue(generated);

        const result = await summaryJobHandler.run(context());

        expect("multiPass" in (result as object)).toBe(false);
    });

    it("announces completion only once the summary is written", async () => {
        (generateSummaryForRecording as Mock).mockResolvedValue(generated);

        await summaryJobHandler.run(context());

        expect(emitEvent).toHaveBeenCalledWith(
            "summary.completed",
            "user-1",
            "rec-1",
        );
        const order = (emitEvent as Mock).mock.invocationCallOrder[0];
        const generation = (generateSummaryForRecording as Mock).mock
            .invocationCallOrder[0];
        expect(order).toBeGreaterThan(generation);
    });

    it("forwards the preset and trigger it was queued with", async () => {
        (generateSummaryForRecording as Mock).mockResolvedValue(generated);

        await summaryJobHandler.run(
            context({
                payload: {
                    recordingId: "rec-9",
                    presetId: "meeting-notes",
                    trigger: "auto",
                },
            }),
        );

        expect(generateSummaryForRecording).toHaveBeenCalledWith(
            "user-1",
            "rec-9",
            expect.objectContaining({
                presetId: "meeting-notes",
                trigger: "auto",
            }),
        );
    });

    it("passes progress straight through to the job row", async () => {
        const reportProgress = vi.fn();
        (generateSummaryForRecording as Mock).mockImplementation(
            async (
                _u: string,
                _r: string,
                opts: { onProgress?: (p: unknown) => void },
            ) => {
                opts.onProgress?.({ phase: "passes", completed: 1, total: 3 });
                return generated;
            },
        );

        await summaryJobHandler.run(context({ reportProgress }));

        expect(reportProgress).toHaveBeenCalledWith({
            phase: "passes",
            completed: 1,
            total: 3,
        });
    });

    it("stays quiet about a failure it is about to retry", async () => {
        (generateSummaryForRecording as Mock).mockRejectedValue(
            new AppError(ErrorCode.AI_RATE_LIMITED, "slow down", 429),
        );

        await expect(
            summaryJobHandler.run(context({ attempt: 1, maxAttempts: 3 })),
        ).rejects.toThrow();

        const failed = (emitEvent as Mock).mock.calls.filter(
            (c) => c[0] === "summary.failed",
        );
        expect(failed).toHaveLength(0);
    });

    it("announces the failure on the last attempt", async () => {
        (generateSummaryForRecording as Mock).mockRejectedValue(
            new AppError(ErrorCode.AI_RATE_LIMITED, "slow down", 429),
        );

        await expect(
            summaryJobHandler.run(context({ attempt: 3, maxAttempts: 3 })),
        ).rejects.toThrow();

        expect(emitEvent).toHaveBeenCalledWith(
            "summary.failed",
            "user-1",
            "rec-1",
            { error: "slow down" },
        );
    });

    it("announces a failure nothing can retry immediately", async () => {
        // No provider configured is not going to be true in thirty seconds
        // either, so there is no later attempt to wait for.
        (generateSummaryForRecording as Mock).mockRejectedValue(
            new AppError(
                ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
                "No AI provider configured",
                400,
            ),
        );

        await expect(
            summaryJobHandler.run(context({ attempt: 1, maxAttempts: 3 })),
        ).rejects.toThrow();

        expect(emitEvent).toHaveBeenCalledWith(
            "summary.failed",
            "user-1",
            "rec-1",
            { error: "No AI provider configured" },
        );
    });

    it("emits the mapped message, not the provider's own", async () => {
        (generateSummaryForRecording as Mock).mockRejectedValue(
            new Error("Incorrect API key sk-abc123 for request req_9"),
        );

        await expect(
            summaryJobHandler.run(context({ attempt: 3, maxAttempts: 3 })),
        ).rejects.toThrow();

        const call = (emitEvent as Mock).mock.calls.find(
            (c) => c[0] === "summary.failed",
        );
        // A webhook payload leaves the instance. A raw provider error can
        // carry key fragments and request ids.
        expect(String(call?.[3]?.error)).not.toContain("sk-abc123");
    });

    it("still rethrows after announcing, so the worker records the failure", async () => {
        (generateSummaryForRecording as Mock).mockRejectedValue(
            new Error("boom"),
        );

        await expect(
            summaryJobHandler.run(context({ attempt: 3, maxAttempts: 3 })),
        ).rejects.toThrow("boom");
    });

    it("does not fail a good summary because a webhook could not be sent", async () => {
        (generateSummaryForRecording as Mock).mockResolvedValue(generated);
        (emitEvent as Mock).mockRejectedValue(new Error("endpoint down"));

        // The summary is written and the user can read it. Failing the job
        // here would retry the whole generation to fix somebody's webhook.
        await expect(summaryJobHandler.run(context())).resolves.toMatchObject({
            provider: "openai",
        });
    });
});
