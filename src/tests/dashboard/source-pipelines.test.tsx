// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { summaryOptions, transcriptSources } = vi.hoisted(() => ({
    summaryOptions: [] as Array<{ summarySource?: string }>,
    transcriptSources: [] as string[],
}));

vi.mock("@/hooks/use-transcription-summary", () => ({
    useTranscriptionSummary: (options: { summarySource?: string }) => {
        summaryOptions.push(options);
        return {
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
        };
    },
}));

vi.mock("@/components/dashboard/transcript-view", () => ({
    TranscriptView: ({ source }: { source: string }) => {
        transcriptSources.push(source);
        return <div data-testid="transcript-source">{source}</div>;
    },
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

import { TranscriptionPanel } from "@/components/dashboard/transcription-panel";

describe("independent transcript and summary pipelines", () => {
    beforeEach(() => {
        summaryOptions.length = 0;
        transcriptSources.length = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ speakers: [] }), {
                    headers: { "Content-Type": "application/json" },
                }),
            ),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("switches the summary without changing the visible transcript", () => {
        render(
            <TranscriptionPanel
                recording={{
                    id: "rec-1",
                    filename: "Meeting.ogg",
                    duration: 60_000,
                    filesize: 1024,
                    startTime: new Date(0).toISOString(),
                    deviceSn: "SN-1",
                }}
                transcripts={[
                    {
                        source: "plaud",
                        text: "Plaud text",
                        provider: "plaud",
                        model: "plaud-native",
                    },
                    {
                        source: "riffado",
                        text: "Custom text",
                        provider: "openai",
                        model: "whisper-1",
                    },
                ]}
                isTranscribing={false}
                onTranscribe={vi.fn()}
            />,
        );

        expect(screen.getByTestId("transcript-source").textContent).toBe(
            "plaud",
        );
        expect(summaryOptions.at(-1)?.summarySource).toBe("plaud");

        const customButtons = screen.getAllByRole("button", {
            name: "Custom",
        });
        fireEvent.click(customButtons[1]);

        expect(screen.getByTestId("transcript-source").textContent).toBe(
            "plaud",
        );
        expect(summaryOptions.at(-1)?.summarySource).toBe("riffado");

        fireEvent.click(screen.getAllByRole("button", { name: "Custom" })[0]);
        expect(screen.getByTestId("transcript-source").textContent).toBe(
            "riffado",
        );
        expect(summaryOptions.at(-1)?.summarySource).toBe("riffado");
    });
});
