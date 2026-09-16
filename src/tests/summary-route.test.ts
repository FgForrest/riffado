import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

/**
 * The manual `POST /api/recordings/[id]/summary` contract.
 *
 * The route no longer generates anything: it queues a durable job and waits
 * for it, so that a summary outlives the request that asked for it. Two things
 * still have to hold across that change, and this pins both:
 *
 *   1. the chosen preset reaches the work -- now via the job payload rather
 *      than a direct call, which is exactly the kind of hop where a value
 *      quietly stops being passed;
 *   2. a caller that did not ask for the event stream gets the same JSON
 *      object it always did.
 */

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({
        user: { id: "user-1", email: "u@example.com" },
    }),
}));

vi.mock("@/lib/summary/summary-job", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@/lib/summary/summary-job")>();
    return { ...actual, enqueueSummaryJob: vi.fn() };
});

vi.mock("@/lib/jobs/watch", () => ({ watchJob: vi.fn() }));
vi.mock("@/lib/export/document-sidecars", () => ({
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/summary/read-summary", () => ({
    readStoredSummary: vi.fn(),
    readStoredSummaries: vi.fn(),
}));
vi.mock("@/db/queries/async-jobs", () => ({ getActiveJob: vi.fn() }));

// `apiHandler` wraps the route in a try/catch that maps thrown AppErrors to
// status codes. The real implementation is used so a regression in error
// mapping also surfaces here; the ownership lookup it guards is stubbed
// below.
const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock("@/db", () => ({
    db: { select: selectMock, transaction: vi.fn() },
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: vi.fn((v: string | null) => v),
    decryptJsonField: vi.fn(),
}));

vi.mock("@/lib/demo/fixtures", () => ({
    DEMO_SUMMARIES: new Map(),
    isDemoRecordingId: vi.fn().mockReturnValue(false),
}));

import { GET, POST } from "@/app/api/recordings/[id]/summary/route";
import { getActiveJob } from "@/db/queries/async-jobs";
import { watchJob } from "@/lib/jobs/watch";
import {
    readStoredSummaries,
    readStoredSummary,
} from "@/lib/summary/read-summary";
import { enqueueSummaryJob } from "@/lib/summary/summary-job";

/** The recording-ownership check the route makes before queueing anything. */
function stubRecordingExists(exists = true) {
    selectMock.mockReturnValue({
        from: () => ({
            where: () => ({
                limit: () => Promise.resolve(exists ? [{ id: "rec-1" }] : []),
            }),
        }),
    });
}

describe("POST /api/recordings/[id]/summary (manual)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubRecordingExists();
        (enqueueSummaryJob as Mock).mockResolvedValue({
            job: { id: "job-1", status: "pending" },
            created: true,
        });
        (watchJob as Mock).mockResolvedValue({
            reason: "settled",
            row: {
                id: "job-1",
                status: "completed",
                result: { provider: "openai", model: "gpt-4o-mini" },
            },
        });
        (readStoredSummary as Mock).mockResolvedValue({
            summary: "ok",
            keyPoints: ["a", "b"],
            actionItems: ["x"],
            source: "riffado",
            transcriptionId: "tr-custom",
            provider: "openai",
            model: "gpt-4o-mini",
            multiPass: undefined,
            createdAt: new Date(0),
        });
    });

    function makeRequest(body: unknown): Request {
        return new Request("http://localhost/api/recordings/rec-1/summary", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    }

    function makeContext(id = "rec-1") {
        return { params: Promise.resolve({ id }) };
    }

    it("forwards preset from body into the queued job", async () => {
        const response = await POST(
            makeRequest({ preset: "meeting-notes" }),
            makeContext(),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            summary: "ok",
            keyPoints: ["a", "b"],
            actionItems: ["x"],
            source: "riffado",
            transcriptionId: "tr-custom",
            provider: "openai",
            model: "gpt-4o-mini",
            promptFallback: false,
        });
        expect(enqueueSummaryJob).toHaveBeenCalledWith({
            userId: "user-1",
            recordingId: "rec-1",
            presetId: "meeting-notes",
            trigger: "manual",
        });
    });

    it("passes presetId: undefined when body omits preset", async () => {
        await POST(makeRequest({}), makeContext());

        expect(enqueueSummaryJob).toHaveBeenCalledWith({
            userId: "user-1",
            recordingId: "rec-1",
            presetId: undefined,
            trigger: "manual",
        });
    });

    it("tolerates a non-JSON body (parses to empty object)", async () => {
        const garbageRequest = new Request(
            "http://localhost/api/recordings/rec-1/summary",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "not-json{",
            },
        );

        const response = await POST(garbageRequest, makeContext());

        expect(response.status).toBe(200);
        expect(enqueueSummaryJob).toHaveBeenCalledWith({
            userId: "user-1",
            recordingId: "rec-1",
            presetId: undefined,
            trigger: "manual",
        });
    });

    it("404s without queueing when the recording is not the caller's", async () => {
        stubRecordingExists(false);

        const response = await POST(makeRequest({}), makeContext());

        expect(response.status).toBe(404);
        // The point of checking ownership in the route: a request that cannot
        // succeed should not leave a job behind for a worker to discover and
        // fail a second later.
        expect(enqueueSummaryJob).not.toHaveBeenCalled();
    });

    it("reports a failed job with the status its error code implies", async () => {
        (watchJob as Mock).mockResolvedValue({
            reason: "settled",
            row: {
                id: "job-1",
                status: "failed",
                errorCode: "AI_PROVIDER_NOT_CONFIGURED",
                lastError: "No AI provider configured",
            },
        });

        const response = await POST(makeRequest({}), makeContext());

        // Not a 500: the worker's failure was the user's configuration, and
        // flattening every job failure to a server error would hide that.
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("No AI provider configured");
    });

    it("answers 202 with the job id when the job outlives the wait", async () => {
        (watchJob as Mock).mockResolvedValue({
            reason: "timeout",
            row: { id: "job-1", status: "processing" },
        });

        const response = await POST(makeRequest({}), makeContext());

        // Nothing failed -- the work is still running, and the caller is told
        // where to follow it rather than being handed an error.
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({
            jobId: "job-1",
            status: "processing",
        });
    });
});

describe("GET /api/recordings/[id]/summary (source variants)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubRecordingExists();
        (getActiveJob as Mock).mockResolvedValue(null);
        (readStoredSummaries as Mock).mockResolvedValue([
            {
                summary: "Plaud summary",
                keyPoints: [],
                actionItems: [],
                source: "plaud",
                transcriptionId: "tr-plaud",
                provider: "plaud",
                model: "plaud-native",
                createdAt: new Date(0),
            },
            {
                summary: "Custom summary",
                keyPoints: [],
                actionItems: [],
                source: "riffado",
                transcriptionId: "tr-custom",
                provider: "openai",
                model: "gpt-4o-mini",
                createdAt: new Date(0),
            },
        ]);
    });

    it("returns the requested pipeline and advertises both variants", async () => {
        const response = await GET(
            new Request(
                "http://localhost/api/recordings/rec-1/summary?source=plaud",
            ),
            { params: Promise.resolve({ id: "rec-1" }) },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            summary: "Plaud summary",
            source: "plaud",
            transcriptionId: "tr-plaud",
            provider: "plaud",
            model: "plaud-native",
            availableSources: ["plaud", "riffado"],
        });
    });
});
