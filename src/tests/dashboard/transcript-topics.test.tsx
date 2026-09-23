// @vitest-environment jsdom

/**
 * Topics in the transcription panel: offered only on a timed transcript of
 * the viewer's own, detected on demand, and a jump that seeks the audio
 * without playing it and scrolls the transcript to the topic's heading.
 */

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/lib/jobs/client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/jobs/client")>();
    // Polls a few milliseconds apart instead of seconds.
    return {
        ...actual,
        followJob: (id: string, opts: object) =>
            actual.followJob(id, {
                ...opts,
                sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
            }),
    };
});
vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: () => ({
        summaryData: null,
        isSummarizing: false,
        summaryProgress: null,
        summaryElapsedMs: 0,
        summaryExpanded: true,
        setSummaryExpanded: vi.fn(),
        summaryPreset: "general",
        setSummaryPreset: vi.fn(),
        summaryPromptOptions: [{ id: "general", name: "General" }],
        handleSummarize: vi.fn(),
        handleDeleteSummary: vi.fn(),
    }),
}));
vi.mock("@/components/people/speaker-tags", () => ({
    SpeakerTags: () => null,
    confirmedAttributions: () => ({}),
}));
vi.mock("@/components/dashboard/transcribe-in-browser-button", () => ({
    TranscribeInBrowserButton: () => null,
}));
vi.mock("@/components/dashboard/markdown-actions", () => ({
    MarkdownActions: () => null,
}));

import {
    TranscriptionPanel,
    type TranscriptOption,
} from "@/components/dashboard/transcription-panel";
import type { Recording } from "@/types/recording";

const RECORDING: Recording = {
    id: "rec-1",
    filename: "Jízdenka.ogg",
    duration: 600_000,
    filesize: 1024,
    startTime: new Date(0).toISOString(),
    deviceSn: "SN-1",
};

const TURNS = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 60_000,
        text: "Objednala jsem jízdenku.",
    },
    {
        speaker: "speaker_1",
        startMs: 60_000,
        endMs: 200_000,
        text: "Datum bylo špatně.",
    },
    {
        speaker: "speaker_0",
        startMs: 200_000,
        endMs: 300_000,
        text: "Přišla kontrola.",
    },
];

const TOPICS = [
    { title: "Objednání jízdenky", fromMs: 18_000, toMs: 67_000 },
    { title: "Špatné datum", fromMs: 67_000, toMs: 300_000 },
];

const PLAUD: TranscriptOption = {
    source: "plaud",
    text: TURNS.map((t) => `${t.speaker}: ${t.text}`).join("\n"),
    provider: "plaud",
    model: "plaud-native",
    turns: TURNS,
};

const fetchMock = vi.fn();

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status });
}

/**
 * A server with a topics job already running: GET names it, and the job
 * settles as `outcome` once the returned function is called.
 */
function serveRunningJob(outcome: "completed" | "failed") {
    let settled = false;
    fetchMock.mockImplementation(async (url: string) => {
        if (url === "/api/jobs/job-1") {
            const status = settled ? outcome : "processing";
            return json({
                id: "job-1",
                kind: "topics",
                status,
                error: status === "failed" ? "The provider timed out" : null,
            });
        }
        if (url.includes("/topics")) {
            return json({
                topics: settled && outcome === "completed" ? TOPICS : null,
                jobId: settled ? null : "job-1",
            });
        }
        return json({ speakers: [] });
    });
    return () => {
        settled = true;
    };
}

function renderPanel(
    transcript: TranscriptOption,
    props: {
        onSeekToTurn?: (ms: number) => void;
        recording?: Recording;
        getPlaybackMs?: () => number;
    } = {},
) {
    return render(
        <TranscriptionPanel
            recording={props.recording ?? RECORDING}
            transcripts={[transcript]}
            isTranscribing={false}
            onTranscribe={vi.fn()}
            onSeekToTurn={props.onSeekToTurn}
            getPlaybackMs={props.getPlaybackMs}
        />,
    );
}

/** Radix opens a dropdown from the keyboard in jsdom, not from a click. */
function openTopics(count: number) {
    fireEvent.keyDown(
        screen.getByRole("button", { name: `Topics (${count})` }),
        { key: "Enter" },
    );
}

describe("transcript topics", () => {
    beforeEach(() => {
        fetchMock.mockReset();
        toastMock.success.mockReset();
        toastMock.error.mockReset();
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ speakers: [] }), { status: 200 }),
        );
        vi.stubGlobal("fetch", fetchMock);
        Element.prototype.scrollTo = vi.fn();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("jumps to a topic: seeks to its start, and highlights its heading", async () => {
        const onSeekToTurn = vi.fn();
        renderPanel({ ...PLAUD, topics: TOPICS }, { onSeekToTurn });

        openTopics(2);
        fireEvent.click(
            await screen.findByRole("menuitem", { name: /Špatné datum/ }),
        );

        expect(onSeekToTurn).toHaveBeenCalledWith(67_000);
        const heading = document.querySelector('[data-topic-index="1"]');
        expect(heading?.className).toContain("bg-primary/10");
        expect(Element.prototype.scrollTo).toHaveBeenCalled();
    });

    it("places each heading above the turn its start falls in", () => {
        renderPanel({ ...PLAUD, topics: TOPICS });

        const section = screen.getByRole("region", {
            name: "Transcript content",
        });
        const order = Array.from(
            section.querySelectorAll("[data-topic-index], [data-turn-index]"),
        ).map((el) =>
            el.hasAttribute("data-topic-index")
                ? `topic ${el.getAttribute("data-topic-index")}`
                : `turn ${el.getAttribute("data-turn-index")}`,
        );
        // 00:18 falls in the first turn, 01:07 in the second.
        expect(order).toEqual([
            "topic 0",
            "turn 0",
            "topic 1",
            "turn 1",
            "turn 2",
        ]);
    });

    it("marks the topic being played", async () => {
        renderPanel(
            { ...PLAUD, topics: TOPICS },
            { getPlaybackMs: () => 100_000 },
        );
        openTopics(2);
        const item = await screen.findByRole("menuitem", {
            name: /Špatné datum/,
        });
        expect(item.className).toContain("text-primary");
        expect(
            screen.getByRole("menuitem", { name: /Objednání jízdenky/ })
                .className,
        ).not.toContain("bg-primary/10");
    });

    it("detects topics on demand and shows them", async () => {
        renderPanel(PLAUD);
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
            url.includes("/topics") && init?.method === "POST"
                ? new Response(JSON.stringify({ topics: TOPICS }), {
                      status: 200,
                  })
                : new Response(JSON.stringify({ speakers: [] }), {
                      status: 200,
                  }),
        );

        fireEvent.click(screen.getByRole("button", { name: "Detect topics" }));

        await screen.findByRole("button", { name: "Topics (2)" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/recordings/rec-1/topics?source=plaud",
            expect.objectContaining({ method: "POST" }),
        );
        expect(screen.getByText("Objednání jízdenky")).toBeTruthy();
    });

    it("picks up a job already running when the page opens", async () => {
        const settle = serveRunningJob("completed");
        renderPanel(PLAUD);

        // The button shows the job instead of inviting a click that would
        // only join it.
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Detecting topics…" }),
            ).toHaveProperty("disabled", true),
        );
        settle();
        await screen.findByRole("button", { name: "Topics (2)" });
        expect(toastMock.success).toHaveBeenCalledWith("Topics detected");
    });

    it("says so when a job it picked up fails", async () => {
        const settle = serveRunningJob("failed");
        renderPanel(PLAUD);
        await screen.findByRole("button", { name: "Detecting topics…" });
        settle();

        await waitFor(() =>
            expect(toastMock.error).toHaveBeenCalledWith(
                "The provider timed out",
            ),
        );
        expect(
            screen.getByRole("button", { name: "Detect topics" }),
        ).toHaveProperty("disabled", false);
    });

    it("does not look for a job where topics cannot be detected", () => {
        renderPanel({ ...PLAUD, turns: null });
        expect(
            fetchMock.mock.calls.some(([url]) =>
                String(url).includes("/topics"),
            ),
        ).toBe(false);
    });

    it("does not offer topics on a transcript without timings", () => {
        renderPanel({ ...PLAUD, turns: null });
        expect(
            screen.queryByRole("button", { name: "Detect topics" }),
        ).toBeNull();
    });

    it("does not offer detection on the Organization view", () => {
        renderPanel(PLAUD, { recording: { ...RECORDING, view: "org" } });
        expect(
            screen.queryByRole("button", { name: "Detect topics" }),
        ).toBeNull();
    });

    it("says why detection failed", async () => {
        renderPanel(PLAUD);
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
            url.includes("/topics") && init?.method === "POST"
                ? new Response(
                      JSON.stringify({
                          error: "No AI provider configured",
                          code: "AI_PROVIDER_NOT_CONFIGURED",
                      }),
                      { status: 400 },
                  )
                : new Response(JSON.stringify({ speakers: [] }), {
                      status: 200,
                  }),
        );

        fireEvent.click(screen.getByRole("button", { name: "Detect topics" }));

        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Detect topics" }),
            ).toHaveProperty("disabled", false),
        );
        expect(screen.queryByRole("button", { name: /Topics \(/ })).toBeNull();
    });
});
