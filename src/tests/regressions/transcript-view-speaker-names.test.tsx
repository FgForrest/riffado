/** Speaker names are a render-time overlay and never rewrite transcript text. */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptView } from "@/components/dashboard/transcript-view";

const TURNS = [
    { speaker: "speaker_0", startMs: 0, endMs: 2000, text: "Ahoj." },
];

describe("TranscriptView speaker names", () => {
    afterEach(cleanup);

    it("projects a confirmed name over the raw speaker label", () => {
        render(
            <TranscriptView
                text="speaker_0: Ahoj."
                source="riffado"
                model="gpt-4o-transcribe-diarize"
                storedTurns={TURNS}
                speakerAttributions={{
                    speaker_0: { personId: "p-1", name: "Jan" },
                }}
            />,
        );

        expect(screen.getByText("Jan")).toBeDefined();
        expect(screen.getByText("Ahoj.")).toBeDefined();
        expect(screen.queryByText("Speaker 0")).toBeNull();
    });

    it("returns to the raw label when the overlay is removed", () => {
        const view = render(
            <TranscriptView
                text="speaker_0: Ahoj."
                source="riffado"
                model="gpt-4o-transcribe-diarize"
                storedTurns={TURNS}
                speakerAttributions={{
                    speaker_0: { personId: "p-1", name: "Jan" },
                }}
            />,
        );

        view.rerender(
            <TranscriptView
                text="speaker_0: Ahoj."
                source="riffado"
                model="gpt-4o-transcribe-diarize"
                storedTurns={TURNS}
                speakerAttributions={{}}
            />,
        );

        expect(screen.getByText("Speaker 0")).toBeDefined();
        expect(screen.queryByText("Jan")).toBeNull();
    });

    it("seeks to the provider-reported turn when its speaker is clicked", () => {
        const onSeekToTurn = vi.fn();
        render(
            <TranscriptView
                text="speaker_0: Ahoj."
                source="riffado"
                model="gpt-4o-transcribe-diarize"
                storedTurns={[
                    {
                        speaker: "speaker_0",
                        startMs: 1250,
                        endMs: 2000,
                        text: "Ahoj.",
                    },
                ]}
                onSeekToTurn={onSeekToTurn}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", {
                name: "Seek audio to 00:01, Speaker 0",
            }),
        );

        expect(onSeekToTurn).toHaveBeenCalledWith(1250);
    });

    it("does not offer seeking for legacy turns without timestamps", () => {
        render(
            <TranscriptView
                text="speaker_0: Ahoj."
                source="plaud"
                onSeekToTurn={vi.fn()}
            />,
        );

        expect(screen.queryByRole("button", { name: /Seek audio/ })).toBeNull();
        expect(screen.getByText("Speaker 0")).toBeDefined();
    });
});
