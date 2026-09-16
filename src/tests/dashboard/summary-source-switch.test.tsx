// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type SummaryData,
    type SummarySource,
    useTranscriptionSummary,
} from "@/hooks/use-transcription-summary";

vi.mock("sonner", () => ({
    toast: {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
    },
}));

interface PendingRequest {
    url: string;
    resolve: (response: Response) => void;
}

let pending: PendingRequest[] = [];

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
    });
}

function summaryBody(source: SummarySource, summary: string): SummaryData {
    return {
        source,
        summary,
        keyPoints: null,
        actionItems: null,
        availableSources: ["plaud", "riffado"],
    };
}

function takeSummaryRequest(source: SummarySource): PendingRequest {
    const query = `source=${source}`;
    const index = pending.findIndex((request) => request.url.includes(query));
    if (index < 0) {
        throw new Error(`Missing ${source} summary request`);
    }
    const [request] = pending.splice(index, 1);
    return request;
}

async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

beforeEach(() => {
    pending = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/settings/user")) {
            return Promise.resolve(jsonResponse({}));
        }
        return new Promise<Response>((resolve) => {
            pending.push({ url, resolve });
        });
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("summary source switching", () => {
    it("keeps prefetched Plaud and custom summaries available while switching", async () => {
        const hook = renderHook(
            (props: { source: SummarySource; transcriptionText: string }) =>
                useTranscriptionSummary({
                    recordingId: "rec-1",
                    summarySource: props.source,
                    transcriptionText: props.transcriptionText,
                }),
            {
                initialProps: {
                    source: "plaud" as SummarySource,
                    transcriptionText: "Plaud transcript",
                },
            },
        );

        await flush();
        takeSummaryRequest("plaud").resolve(
            jsonResponse(summaryBody("plaud", "Plaud summary")),
        );
        await flush();
        takeSummaryRequest("riffado").resolve(
            jsonResponse(summaryBody("riffado", "Custom summary")),
        );
        await flush();

        expect(hook.result.current.summaryData?.summary).toBe("Plaud summary");

        hook.rerender({
            source: "riffado",
            transcriptionText: "Custom transcript",
        });
        expect(hook.result.current.summaryData?.summary).toBe("Custom summary");

        hook.rerender({
            source: "plaud",
            transcriptionText: "Plaud transcript",
        });
        expect(hook.result.current.summaryData?.summary).toBe("Plaud summary");
    });
});
