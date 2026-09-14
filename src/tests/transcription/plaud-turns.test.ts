import { describe, expect, it } from "vitest";
import { parseTranscript, segmentsToTurns } from "@/lib/plaud/content";
import { renderTurnsAsText } from "@/lib/transcription/turns";
import { expectTextAndTurnsAgree } from "./turns-parity";

const segments = [
    { start_time: 0, end_time: 2, speaker: 1, content: "Ahoj" },
    { start_time: 2, end_time: 4, speaker: 2, content: "Zdravim" },
];

describe("segmentsToTurns", () => {
    it("treats times as seconds when they are tiny against the duration", () => {
        // A 10-minute recording whose last segment ends at 4 can only be seconds.
        expect(segmentsToTurns(segments, 600_000)).toEqual([
            { speaker: "Speaker 1", startMs: 0, endMs: 2000, text: "Ahoj" },
            {
                speaker: "Speaker 2",
                startMs: 2000,
                endMs: 4000,
                text: "Zdravim",
            },
        ]);
    });

    it("treats times as milliseconds when they are comparable to the duration", () => {
        expect(
            segmentsToTurns(
                [
                    {
                        start_time: 0,
                        end_time: 2000,
                        speaker: 1,
                        content: "Ahoj",
                    },
                    {
                        start_time: 2000,
                        end_time: 4000,
                        speaker: 2,
                        content: "Zdravim",
                    },
                ],
                5_000,
            ),
        ).toEqual([
            { speaker: "Speaker 1", startMs: 0, endMs: 2000, text: "Ahoj" },
            {
                speaker: "Speaker 2",
                startMs: 2000,
                endMs: 4000,
                text: "Zdravim",
            },
        ]);
    });

    it("falls back to milliseconds when no duration is known", () => {
        const [first] = segmentsToTurns(segments) ?? [];
        expect(first.endMs).toBe(2);
    });

    it("uses the same labels parseTranscript writes into the flat text", () => {
        expectTextAndTurnsAgree(
            parseTranscript(segments).text,
            segmentsToTurns(segments, 600_000) ?? undefined,
        );
    });

    it("groups a same-speaker run the way parseTranscript does", () => {
        const run = [
            { start_time: 0, end_time: 2, speaker: 1, content: "Ahoj" },
            { start_time: 2, end_time: 4, speaker: 1, content: "jeste jednou" },
        ];

        expectTextAndTurnsAgree(
            parseTranscript(run).text,
            segmentsToTurns(run, 600_000) ?? undefined,
        );
    });

    it("agrees with parseTranscript across an empty segment in a run", () => {
        const run = [
            { start_time: 0, end_time: 2, speaker: 1, content: "Ahoj" },
            { start_time: 2, end_time: 3, speaker: 1, content: "   " },
            { start_time: 3, end_time: 4, speaker: 1, content: "jeste jednou" },
        ];

        expectTextAndTurnsAgree(
            parseTranscript(run).text,
            segmentsToTurns(run, 600_000) ?? undefined,
        );
    });

    it("keeps millisecond times intact on a mostly silent recording", () => {
        const sparse = [
            { start_time: 0, end_time: 30_000, speaker: 1, content: "Ahoj" },
        ];

        const [first] = segmentsToTurns(sparse, 3_600_000) ?? [];
        expect(first.endMs).toBe(30_000);
    });

    it("keeps unlabelled segments unprefixed", () => {
        const turns =
            segmentsToTurns(
                [{ start_time: 0, end_time: 1, content: "Ahoj" }],
                60_000,
            ) ?? [];
        expect(turns[0].speaker).toBe("");
        expect(renderTurnsAsText(turns)).toBe("Ahoj");
    });

    it("returns null when nothing has content", () => {
        expect(
            segmentsToTurns([{ start_time: 0, content: "  " }], 1000),
        ).toBeNull();
    });
});
