import { describe, expect, it } from "vitest";
import { parseTranscript, segmentsToTurns } from "@/lib/plaud/content";
import { renderTurnsAsText } from "@/lib/transcription/turns";

const segments = [
    { start_time: 0, end_time: 2, speaker: 1, content: "Ahoj" },
    { start_time: 2, end_time: 4, speaker: 2, content: "Zdravim" },
];

describe("segmentsToTurns", () => {
    it("treats times as seconds when they are tiny against the duration", () => {
        // A 10-minute recording whose last segment ends at 4 can only be seconds.
        expect(segmentsToTurns(segments, 600_000)).toEqual([
            { speaker: "Speaker 1", startMs: 0, endMs: 2000, text: "Ahoj" },
            { speaker: "Speaker 2", startMs: 2000, endMs: 4000, text: "Zdravim" },
        ]);
    });

    it("treats times as milliseconds when they are comparable to the duration", () => {
        expect(
            segmentsToTurns(
                [
                    { start_time: 0, end_time: 2000, speaker: 1, content: "Ahoj" },
                    { start_time: 2000, end_time: 4000, speaker: 2, content: "Zdravim" },
                ],
                5_000,
            ),
        ).toEqual([
            { speaker: "Speaker 1", startMs: 0, endMs: 2000, text: "Ahoj" },
            { speaker: "Speaker 2", startMs: 2000, endMs: 4000, text: "Zdravim" },
        ]);
    });

    it("falls back to milliseconds when no duration is known", () => {
        const [first] = segmentsToTurns(segments) ?? [];
        expect(first.endMs).toBe(2);
    });

    it("uses the same labels parseTranscript writes into the flat text", () => {
        const turns = segmentsToTurns(segments, 600_000) ?? [];
        expect(renderTurnsAsText(turns)).toBe(
            parseTranscript(segments).text,
        );
    });

    it("keeps unlabelled segments unprefixed", () => {
        const turns =
            segmentsToTurns([{ start_time: 0, end_time: 1, content: "Ahoj" }], 60_000) ?? [];
        expect(turns[0].speaker).toBe("");
        expect(renderTurnsAsText(turns)).toBe("Ahoj");
    });

    it("returns null when nothing has content", () => {
        expect(segmentsToTurns([{ start_time: 0, content: "  " }], 1000)).toBeNull();
    });
});
