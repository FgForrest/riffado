/**
 * `POST /api/recordings/[id]/summary` -- the streaming branch.
 *
 * Three properties matter, and the move to a durable job changed the shape of
 * all three without changing what they promise.
 *
 * The JSON response stays the default, because every existing caller depends
 * on it. Once the stream opens the status is already 200, so a failure has to
 * arrive as an event; a client that trusts `response.ok` would otherwise read
 * a crash as a success. And a stream that ends without a verdict must NOT be
 * reported as one -- the work now outlives the request, so the client is
 * handed a job id up front and expected to go and ask.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
    createStreamEventParser,
    type SummaryStreamEvent,
} from "@/lib/summary/progress-stream";

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string) => v,
    decryptJsonField: <T>(v: T) => v,
}));

vi.mock("@/lib/demo/fixtures", () => ({
    DEMO_SUMMARIES: new Map(),
    isDemoRecordingId: () => false,
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

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
vi.mock("@/db", () => ({ db: { select: selectMock, transaction: vi.fn() } }));

import { POST } from "@/app/api/recordings/[id]/summary/route";
import { watchJob } from "@/lib/jobs/watch";
import { readStoredSummary } from "@/lib/summary/read-summary";
import { enqueueSummaryJob } from "@/lib/summary/summary-job";

function stubRecordingExists() {
    selectMock.mockReturnValue({
        from: () => ({
            where: () => ({ limit: () => Promise.resolve([{ id: "rec-1" }]) }),
        }),
    });
}

/**
 * Drive `watchJob` the way the real one behaves: report each progress
 * snapshot in turn, then settle.
 */
function stageJob(
    progressSnapshots: Record<string, unknown>[],
    final: Record<string, unknown>,
    reason: "settled" | "timeout" = "settled",
) {
    (watchJob as Mock).mockImplementation(
        async (
            _jobId: string,
            _userId: string,
            opts: {
                onProgress?: (p: Record<string, unknown>) => void;
                onPoll?: (row: unknown) => void;
            },
        ) => {
            for (const snapshot of progressSnapshots) {
                opts.onPoll?.(final);
                opts.onProgress?.(snapshot);
            }
            return { row: final, reason };
        },
    );
}

async function post(accept?: string) {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (accept) headers.Accept = accept;
    return POST(
        new Request("http://localhost/api/recordings/rec-1/summary", {
            method: "POST",
            body: JSON.stringify({}),
            headers,
        }),
        { params: Promise.resolve({ id: "rec-1" }) },
    );
}

async function readEvents(res: Response): Promise<SummaryStreamEvent[]> {
    const parse = createStreamEventParser();
    return parse(await res.text());
}

describe("POST /api/recordings/[id]/summary — streaming", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stubRecordingExists();
        (enqueueSummaryJob as Mock).mockResolvedValue({
            job: { id: "job-1", status: "pending" },
            created: true,
        });
        (readStoredSummary as Mock).mockResolvedValue({
            summary: "s",
            keyPoints: ["k"],
            actionItems: [],
            source: "riffado",
            transcriptionId: "tr-custom",
            provider: "openai",
            model: "gpt-4o-mini",
            multiPass: undefined,
            createdAt: new Date(0),
        });
        stageJob([], { id: "job-1", status: "completed", result: {} });
    });

    it("answers with JSON when the caller does not ask for a stream", async () => {
        const res = await post();

        // The v1 API and the existing API tests depend on this.
        expect(res.headers.get("content-type")).toContain("application/json");
        expect((await res.json()).summary).toBe("s");
    });

    it("announces the job id before anything else", async () => {
        const events = await readEvents(await post("text/event-stream"));

        // First, so a connection that dies one second later still leaves the
        // client able to find the work.
        expect(events[0]).toEqual({ type: "queued", jobId: "job-1" });
    });

    it("streams a progress event per pass, then the result", async () => {
        stageJob(
            [
                { phase: "passes", completed: 1, total: 3 },
                { phase: "passes", completed: 2, total: 3 },
                { phase: "passes", completed: 3, total: 3 },
                { phase: "merging", completed: 3, total: 3 },
            ],
            {
                id: "job-1",
                status: "completed",
                result: { provider: "openai", model: "gpt-4o-mini" },
            },
        );

        const res = await post("text/event-stream");
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        // A proxy that buffers the stream would deliver every event at once,
        // after the work they describe had already finished.
        expect(res.headers.get("cache-control")).toContain("no-transform");

        const events = await readEvents(res);
        const progress = events.filter((e) => e.type === "progress");
        const results = events.filter((e) => e.type === "result");

        expect(progress).toHaveLength(4);
        expect(progress.at(-1)).toMatchObject({ phase: "merging" });
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            type: "result",
            result: { summary: "s", keyPoints: ["k"] },
        });
    });

    it("drops a progress snapshot it cannot render", async () => {
        // The job row's `progress` is shared by every job kind, so a snapshot
        // that is not multi-pass progress must not reach the client as
        // `NaN/NaN`.
        stageJob(
            [
                { phase: "indexing", chunk: 4 },
                { phase: "passes", completed: 1, total: 2 },
            ],
            { id: "job-1", status: "completed", result: {} },
        );

        const events = await readEvents(await post("text/event-stream"));

        expect(events.filter((e) => e.type === "progress")).toEqual([
            { type: "progress", phase: "passes", completed: 1, total: 2 },
        ]);
    });

    it("streams no progress for a single-pass run, just the result", async () => {
        const events = await readEvents(await post("text/event-stream"));

        expect(events.filter((e) => e.type === "progress")).toHaveLength(0);
        expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    });

    it("reports a failure as an event, since the status is already 200", async () => {
        stageJob([], {
            id: "job-1",
            status: "failed",
            errorCode: "AI_PROVIDER_NOT_CONFIGURED",
            lastError: "No AI provider configured",
        });

        const res = await post("text/event-stream");
        // Not a 500: the headers went out before anything could fail.
        expect(res.status).toBe(200);

        const events = await readEvents(res);
        expect(events.filter((e) => e.type === "result")).toHaveLength(0);
        expect(events.at(-1)).toMatchObject({
            type: "error",
            error: "No AI provider configured",
        });
    });

    it("ends quietly when the job outlives the request", async () => {
        stageJob(
            [{ phase: "passes", completed: 1, total: 3 }],
            { id: "job-1", status: "processing" },
            "timeout",
        );

        const events = await readEvents(await post("text/event-stream"));

        // No verdict, because there is none to give: the job is still
        // running. An error here would tell the user their summary failed
        // while a worker was busy producing it. The `queued` event is what
        // lets the client pick the story back up.
        expect(events.filter((e) => e.type === "error")).toHaveLength(0);
        expect(events.filter((e) => e.type === "result")).toHaveLength(0);
        expect(events[0]).toMatchObject({ type: "queued" });
    });

    it("says so when a job succeeds but left no summary behind", async () => {
        (readStoredSummary as Mock).mockResolvedValue(null);

        const events = await readEvents(await post("text/event-stream"));

        // Silence would leave the user watching a spinner vanish with no
        // summary and no explanation.
        expect(events.at(-1)).toMatchObject({ type: "error" });
    });

    it("keeps the connection alive while a long pass reports nothing", async () => {
        (watchJob as Mock).mockImplementation(
            async (
                _jobId: string,
                _userId: string,
                opts: { onPoll?: (row: unknown) => void },
            ) => {
                // Two polls far enough apart that the keep-alive is due.
                opts.onPoll?.(null);
                vi.setSystemTime(Date.now() + 30_000);
                opts.onPoll?.(null);
                return {
                    row: { id: "job-1", status: "completed", result: {} },
                    reason: "settled",
                };
            },
        );
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const body = await (await post("text/event-stream")).text();
            // A proxy that sees nothing for a minute closes the connection,
            // and a multi-pass run genuinely reports nothing for that long.
            expect(body).toContain(": keep-alive");
        } finally {
            vi.useRealTimers();
        }
    });
});
