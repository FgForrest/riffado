/**
 * Whisper's verbose format stores speakerless paragraphs. They have no
 * speaker name to click, so the start time is the seek control instead.
 */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptView } from "@/components/dashboard/transcript-view";

const PARAGRAPHS = [
    { speaker: "", startMs: 0, endMs: 4000, text: "Ahoj. Jak se máš?" },
    { speaker: "", startMs: 65_000, endMs: 70_000, text: "Dobře." },
];

describe("TranscriptView speakerless paragraphs", () => {
    afterEach(cleanup);

    it("seeks to a paragraph when its start time is clicked", () => {
        const onSeekToTurn = vi.fn();
        render(
            <TranscriptView
                text={"Ahoj. Jak se máš?\nDobře."}
                source="riffado"
                model="whisper-1"
                storedTurns={PARAGRAPHS}
                onSeekToTurn={onSeekToTurn}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Seek audio to 01:05" }),
        );

        expect(onSeekToTurn).toHaveBeenCalledWith(65_000);
        expect(screen.getByText("Dobře.")).toBeDefined();
    });

    it("shows no time and no speaker when audio cannot be sought", () => {
        render(
            <TranscriptView
                text={"Ahoj. Jak se máš?\nDobře."}
                source="riffado"
                model="whisper-1"
                storedTurns={PARAGRAPHS}
            />,
        );

        expect(screen.queryByRole("button")).toBeNull();
        expect(screen.queryByText("00:00")).toBeNull();
        expect(screen.getByText("Ahoj. Jak se máš?")).toBeDefined();
    });
});
