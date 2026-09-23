/**
 * The timeline topics are anchored to. The model only ever sees times taken
 * from here, and the transcript view places headings with the same lookups,
 * so a topic lands where its time says in both.
 */

import { describe, expect, it } from "vitest";
import {
    activeTopicIndex,
    buildTimeMarks,
    containingTurnIndex,
    formatClock,
    parseClock,
    renderTimedTranscript,
    splitIntoWindows,
    type TimeMark,
} from "@/lib/topics/timeline";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const turn = (
    speaker: string,
    startS: number,
    endS: number,
    text: string,
): TranscriptTurn => ({
    speaker,
    startMs: startS * 1000,
    endMs: endS * 1000,
    text,
});

describe("buildTimeMarks", () => {
    it("marks the start of every turn of normal length", () => {
        const marks = buildTimeMarks([
            turn("speaker_0", 0, 10, "Ahoj."),
            turn("speaker_1", 10, 20, "Dobrý den."),
        ]);
        expect(marks).toEqual([
            { ms: 0, turnIndex: 0, speaker: "Speaker 0", text: "Ahoj." },
            {
                ms: 10_000,
                turnIndex: 1,
                speaker: "Speaker 1",
                text: "Dobrý den.",
            },
        ]);
    });

    it("adds marks inside a long turn, at sentence starts, by character position", () => {
        // Four sentences of equal length over 100 s: about 25 s apart.
        const sentence = (n: number) => `Věta číslo ${n} je tady ok.`;
        const text = [1, 2, 3, 4].map(sentence).join(" ");
        const marks = buildTimeMarks([turn("speaker_0", 60, 60 + 100, text)]);

        expect(marks.map((mark) => mark.text)).toEqual(
            [1, 2, 3, 4].map(sentence),
        );
        // Joining spaces shift the later starts by up to a second.
        marks.forEach((mark, i) => {
            expect(Math.abs(mark.ms - (60 + 25 * i) * 1000)).toBeLessThan(1000);
        });
        // Only the first line of the turn names the speaker.
        expect(marks.map((mark) => mark.speaker)).toEqual([
            "Speaker 0",
            null,
            null,
            null,
        ]);
    });

    it("keeps marks inside a long turn at least 15 s apart", () => {
        const text = Array.from({ length: 20 }, () => "Krátká věta.").join(" ");
        const marks = buildTimeMarks([turn("", 0, 100, text)]);
        const gaps = marks.slice(1).map((mark, i) => mark.ms - marks[i].ms);
        expect(gaps.every((gap) => gap >= 15_000)).toBe(true);
        expect(marks.map((mark) => mark.text).join(" ")).toBe(text);
    });

    it("gives a speakerless paragraph no speaker and skips blank turns", () => {
        const marks = buildTimeMarks([
            turn("", 0, 5, "Odstavec."),
            turn("speaker_0", 5, 6, "   "),
        ]);
        expect(marks).toEqual([
            { ms: 0, turnIndex: 0, speaker: "", text: "Odstavec." },
        ]);
    });
});

describe("clock times", () => {
    it("formats minutes and hours the way the model is shown them", () => {
        expect(formatClock(0)).toBe("00:00");
        expect(formatClock(222_900)).toBe("03:42");
        expect(formatClock(3_723_000)).toBe("1:02:03");
    });

    it("reads back what it formats, brackets included", () => {
        for (const ms of [0, 222_000, 3_723_000]) {
            expect(parseClock(formatClock(ms))).toBe(ms);
            expect(parseClock(`[${formatClock(ms)}]`)).toBe(ms);
        }
        expect(parseClock("3:42")).toBe(222_000);
    });

    it("rejects anything that is not a clock time", () => {
        for (const value of ["", "3.42", "03:75", "abc", 222, null]) {
            expect(parseClock(value)).toBeNull();
        }
    });
});

describe("renderTimedTranscript", () => {
    it("prefixes every line with its time, and the speaker where one starts", () => {
        const marks: TimeMark[] = [
            { ms: 0, turnIndex: 0, speaker: "Speaker 1", text: "Ahoj." },
            { ms: 20_000, turnIndex: 0, speaker: null, text: "Pokračuji." },
            { ms: 30_000, turnIndex: 1, speaker: "", text: "Bez mluvčího." },
        ];
        expect(renderTimedTranscript(marks)).toBe(
            "[00:00] Speaker 1: Ahoj.\n[00:20] Pokračuji.\n[00:30] Bez mluvčího.",
        );
    });
});

describe("splitIntoWindows", () => {
    const marks: TimeMark[] = Array.from({ length: 10 }, (_, i) => ({
        ms: i * 60_000,
        turnIndex: i,
        speaker: "S",
        // Each line renders to 21 characters, 22 with its newline.
        text: "x".repeat(10),
    }));

    it("sends a short transcript in one window that keeps everything", () => {
        const windows = splitIntoWindows(marks, 10_000, 100);
        expect(windows).toHaveLength(1);
        expect(windows[0].marks).toHaveLength(10);
        expect(windows[0].keepFromMs).toBe(Number.NEGATIVE_INFINITY);
    });

    it("overlaps consecutive windows and hands over in the middle of the overlap", () => {
        const windows = splitIntoWindows(marks, 22 * 4, 22 * 2);
        const ranges = windows.map((w) => w.marks.map((m) => m.turnIndex));
        expect(ranges).toEqual([
            [0, 1, 2, 3],
            [2, 3, 4, 5],
            [4, 5, 6, 7],
            [6, 7, 8, 9],
        ]);
        // Overlap [2, 3]: minutes 2 and 3, handed over at 2.5.
        expect(windows[1].keepFromMs).toBe(150_000);
        expect(windows[2].keepFromMs).toBe(270_000);
    });

    it("still advances when a single line is longer than a window", () => {
        const windows = splitIntoWindows(marks.slice(0, 3), 5, 5);
        expect(windows.map((w) => w.marks.length)).toEqual([1, 1, 1]);
    });
});

describe("containingTurnIndex", () => {
    const turns = [{ startMs: 0 }, { startMs: 10_000 }, { startMs: 30_000 }];

    it("finds the turn a moment falls in, gaps between turns included", () => {
        expect(containingTurnIndex(turns, 0)).toBe(0);
        expect(containingTurnIndex(turns, 12_000)).toBe(1);
        expect(containingTurnIndex(turns, 29_999)).toBe(1);
        expect(containingTurnIndex(turns, 90_000)).toBe(2);
    });

    it("falls back to the first turn before it starts", () => {
        expect(containingTurnIndex([{ startMs: 5_000 }], 1_000)).toBe(0);
    });
});

describe("activeTopicIndex", () => {
    const topics = [
        { title: "A", fromMs: 5_000, toMs: 20_000 },
        { title: "B", fromMs: 20_000, toMs: 40_000 },
    ];

    it("is the last topic started, or none before the first", () => {
        expect(activeTopicIndex(topics, 0)).toBe(-1);
        expect(activeTopicIndex(topics, 5_000)).toBe(0);
        expect(activeTopicIndex(topics, 39_000)).toBe(1);
    });
});
