import { describe, expect, it } from "vitest";
import {
    renderTurnsAsText,
    type TranscriptTurn,
    turnsFromLabelledSegments,
} from "@/lib/transcription/turns";

const turns: TranscriptTurn[] = [
    { speaker: "speaker_0", startMs: 0, endMs: 2000, text: "Ahoj, tady Jan." },
    { speaker: "speaker_1", startMs: 2000, endMs: 4000, text: "Zdravím." },
    { speaker: "speaker_0", startMs: 4000, endMs: 6000, text: "Jdeme na to." },
];

describe("renderTurnsAsText", () => {
    it("renders raw labels when no resolver is given", () => {
        expect(renderTurnsAsText(turns)).toBe(
            "speaker_0: Ahoj, tady Jan.\nspeaker_1: Zdravím.\nspeaker_0: Jdeme na to.",
        );
    });

    it("substitutes resolved names without mutating the turns", () => {
        const resolve = (speaker: string) =>
            speaker === "speaker_0" ? "Jan Novotný" : null;

        expect(renderTurnsAsText(turns, resolve)).toBe(
            "Jan Novotný: Ahoj, tady Jan.\nspeaker_1: Zdravím.\nJan Novotný: Jdeme na to.",
        );
        expect(turns[0].speaker).toBe("speaker_0");
    });

    it("keeps the raw label when the resolver returns null", () => {
        expect(renderTurnsAsText(turns, () => null)).toBe(
            renderTurnsAsText(turns),
        );
    });

    it("omits the prefix for a turn with no speaker", () => {
        expect(
            renderTurnsAsText([
                { speaker: "", startMs: 0, endMs: 1000, text: "Hi" },
            ]),
        ).toBe("Hi");
    });

    it("drops turns whose text is blank", () => {
        expect(
            renderTurnsAsText([
                { speaker: "speaker_0", startMs: 0, endMs: 1, text: "   " },
                { speaker: "speaker_1", startMs: 1, endMs: 2, text: "Ano." },
            ]),
        ).toBe("speaker_1: Ano.");
    });

    it("returns an empty string for no turns", () => {
        expect(renderTurnsAsText([])).toBe("");
    });
});

describe("turnsFromLabelledSegments", () => {
    it("merges consecutive segments from the same speaker", () => {
        expect(
            turnsFromLabelledSegments([
                { speaker: "S1", startMs: 0, endMs: 1000, text: "Ahoj" },
                {
                    speaker: "S1",
                    startMs: 1000,
                    endMs: 2000,
                    text: "tady Jan.",
                },
                { speaker: "S2", startMs: 2000, endMs: 3000, text: "Zdravím." },
            ]),
        ).toEqual([
            { speaker: "S1", startMs: 0, endMs: 2000, text: "Ahoj tady Jan." },
            { speaker: "S2", startMs: 2000, endMs: 3000, text: "Zdravím." },
        ]);
    });

    it("extends the turn's end time as segments are merged", () => {
        const turns = turnsFromLabelledSegments([
            { speaker: "S1", startMs: 500, endMs: 1000, text: "a" },
            { speaker: "S1", startMs: 4000, endMs: 9000, text: "b" },
        ]);

        expect(turns?.[0].startMs).toBe(500);
        expect(turns?.[0].endMs).toBe(9000);
    });

    it("treats a change of speaker as a new turn even when times are adjacent", () => {
        expect(
            turnsFromLabelledSegments([
                { speaker: "S1", startMs: 0, endMs: 100, text: "a" },
                { speaker: "S2", startMs: 100, endMs: 200, text: "b" },
                { speaker: "S1", startMs: 200, endMs: 300, text: "c" },
            ])?.map((turn) => turn.speaker),
        ).toEqual(["S1", "S2", "S1"]);
    });

    it("skips segments with no text", () => {
        expect(
            turnsFromLabelledSegments([
                { speaker: "S1", startMs: 0, endMs: 100, text: "  " },
                { speaker: "S1", startMs: 100, endMs: 200, text: "ano" },
            ]),
        ).toEqual([{ speaker: "S1", startMs: 100, endMs: 200, text: "ano" }]);
    });

    it("returns null when there are no usable segments", () => {
        expect(turnsFromLabelledSegments([])).toBeNull();
    });
});
