/**
 * The model's reply is untrusted. Nothing it says reaches storage except as
 * a title on one of the transcript's own time marks.
 */

import { describe, expect, it } from "vitest";
import {
    anchorTopics,
    finishTopics,
    isTopicList,
    joinWindowTopics,
    MAX_TOPICS,
    parseTopicsReply,
} from "@/lib/topics/anchor";
import type { MarkWindow, TimeMark } from "@/lib/topics/timeline";

const mark = (seconds: number): TimeMark => ({
    ms: seconds * 1000,
    turnIndex: 0,
    speaker: null,
    text: "",
});

const MARKS = [0, 30, 70, 125].map(mark);

describe("parseTopicsReply", () => {
    const topics = [{ start: "00:00", title: "Úvod" }];

    it("reads the plain object, a fenced one, one with prose around it, and a bare array", () => {
        const json = JSON.stringify({ topics });
        for (const reply of [
            json,
            `\`\`\`json\n${json}\n\`\`\``,
            `Here you go:\n${json}\nHope this helps.`,
            JSON.stringify(topics),
        ]) {
            expect(parseTopicsReply(reply)).toEqual(topics);
        }
    });

    it("returns null when there is no topic list to read", () => {
        for (const reply of ["", "no JSON here", '{"summary": "x"}']) {
            expect(parseTopicsReply(reply)).toBeNull();
        }
    });

    it("drops entries that are not objects", () => {
        expect(
            parseTopicsReply(
                JSON.stringify({ topics: ["x", null, topics[0]] }),
            ),
        ).toEqual(topics);
    });
});

describe("anchorTopics", () => {
    it("snaps each start to the nearest time the model was shown", () => {
        expect(
            anchorTopics(
                [
                    { start: "00:00", title: "Úvod" },
                    // Misquoted: 01:12 is nearest to the 01:10 mark.
                    { start: "01:12", title: "Datum" },
                ],
                MARKS,
                200_000,
            ),
        ).toEqual([
            { title: "Úvod", fromMs: 0, toMs: 0 },
            { title: "Datum", fromMs: 70_000, toMs: 0 },
        ]);
    });

    it("drops starts that do not parse or lie past the end, and topics without a title", () => {
        expect(
            anchorTopics(
                [
                    { start: "soon", title: "A" },
                    { start: 30, title: "B" },
                    { start: "59:00", title: "C" },
                    { start: "00:30", title: "   " },
                    { start: "00:30", title: 42 },
                ],
                MARKS,
                200_000,
            ),
        ).toEqual([]);
    });

    it("sorts by time and keeps the first title for a mark", () => {
        expect(
            anchorTopics(
                [
                    { start: "02:05", title: "Konec" },
                    { start: "00:30", title: "První" },
                    { start: "00:31", title: "Druhý" },
                ],
                MARKS,
                200_000,
            ).map((topic) => topic.title),
        ).toEqual(["První", "Konec"]);
    });

    it("cleans titles: whitespace, surrounding quotes, and overlong ones", () => {
        const [topic] = anchorTopics(
            [{ start: "00:00", title: `  "${"Dlouhé ".repeat(20)}"  ` }],
            MARKS,
            200_000,
        );
        expect(topic.title.startsWith("Dlouhé Dlouhé")).toBe(true);
        expect(topic.title.length).toBeLessThanOrEqual(80);
        expect(topic.title.endsWith("…")).toBe(true);
    });

    it("anchors nothing without marks", () => {
        expect(
            anchorTopics([{ start: "00:00", title: "A" }], [], 1000),
        ).toEqual([]);
    });
});

describe("joinWindowTopics", () => {
    it("lets each window decide only its own stretch", () => {
        const windows: MarkWindow[] = [
            { marks: [], keepFromMs: Number.NEGATIVE_INFINITY },
            { marks: [], keepFromMs: 100_000 },
        ];
        const topic = (seconds: number, title: string) => ({
            title,
            fromMs: seconds * 1000,
            toMs: 0,
        });
        expect(
            joinWindowTopics(windows, [
                [topic(0, "A"), topic(90, "B"), topic(110, "late in first")],
                [topic(80, "continuation"), topic(110, "C")],
            ]).map((t) => t.title),
        ).toEqual(["A", "B", "C"]);
    });
});

describe("finishTopics", () => {
    const topic = (seconds: number, title: string) => ({
        title,
        fromMs: seconds * 1000,
        toMs: 0,
    });

    it("ends each topic where the next begins, and the last at the end", () => {
        expect(finishTopics([topic(0, "A"), topic(60, "B")], 200_000)).toEqual([
            { title: "A", fromMs: 0, toMs: 60_000 },
            { title: "B", fromMs: 60_000, toMs: 200_000 },
        ]);
    });

    it("merges neighbours that got the same title, as window seams can produce", () => {
        expect(
            finishTopics(
                [topic(0, "Úvod"), topic(40, "úvod"), topic(90, "Jiné")],
                100_000,
            ),
        ).toEqual([
            { title: "Úvod", fromMs: 0, toMs: 90_000 },
            { title: "Jiné", fromMs: 90_000, toMs: 100_000 },
        ]);
    });

    it("caps the number of topics", () => {
        const many = Array.from({ length: MAX_TOPICS + 5 }, (_, i) =>
            topic(i, `T${i}`),
        );
        expect(finishTopics(many, 1_000_000)).toHaveLength(MAX_TOPICS);
    });
});

describe("isTopicList", () => {
    it("accepts stored topics and rejects anything else", () => {
        expect(isTopicList([{ title: "A", fromMs: 0, toMs: 1 }])).toBe(true);
        expect(isTopicList([{ title: "A", fromMs: "0", toMs: 1 }])).toBe(false);
        expect(isTopicList({ topics: [] })).toBe(false);
    });
});
