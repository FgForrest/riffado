import { describe, expect, it } from "vitest";
import type { ContentSegment } from "@/lib/content/types";
import {
    MAIL_PART_MS,
    mailLearnParts,
    mailPartAt,
    mailRangeAt,
} from "@/lib/learn/mail-parts";

const body =
    "Eva will lead the pilot at Acme.\n\nShe starts in November.\n  \nThanks.";
const segments: ContentSegment[] = [
    {
        index: 0,
        role: "body",
        participantRef: "p1",
        depth: 0,
        at: null,
        text: body,
    },
    {
        index: 1,
        role: "signature",
        participantRef: "p1",
        depth: 0,
        at: null,
        text: "Jan Novotny\nHead of Sales\n\nAcme",
    },
    {
        index: 2,
        role: "quoted",
        participantRef: "p2",
        depth: 1,
        at: new Date("2026-10-08T15:40:00Z"),
        text: "We agree.",
    },
    {
        index: 3,
        role: "quoted",
        participantRef: "p3",
        depth: 2,
        at: null,
        text: "Already in the pile.",
        knownItemId: "m0",
    },
];

describe("mail parts for Learn", () => {
    it("makes one turn per paragraph, signatures whole, known quotes skipped", () => {
        const { turns, parts } = mailLearnParts({ segments });
        expect(turns.map((turn) => turn.text)).toEqual([
            "Eva will lead the pilot at Acme.",
            "She starts in November.",
            "Thanks.",
            "(signature) Jan Novotny\nHead of Sales\n\nAcme",
            "(quoted, written 2026-10-08) We agree.",
        ]);
        expect(turns.map((turn) => turn.speaker)).toEqual([
            "p1",
            "p1",
            "p1",
            "p1",
            "p2",
        ]);
        expect(turns[1]).toMatchObject({
            startMs: MAIL_PART_MS,
            endMs: 2 * MAIL_PART_MS - 1,
        });
        // Each part maps back to its words in the segment.
        for (const [index, part] of parts.entries()) {
            const segment = segments[part.segmentIndex];
            expect(
                turns[index]?.text.endsWith(
                    segment?.text.slice(part.charStart, part.charEnd) ?? "?",
                ),
            ).toBe(true);
        }
    });

    it("leaves out what it is told was read before", () => {
        const { turns } = mailLearnParts({ segments }, { skip: new Set([1]) });
        expect(turns.some((turn) => turn.text.startsWith("(signature)"))).toBe(
            false,
        );
    });

    it("reads a time back as the part, and a span within one segment as one range", () => {
        const { parts } = mailLearnParts({ segments });
        expect(mailPartAt(parts, MAIL_PART_MS + 5)).toMatchObject({
            segmentIndex: 0,
            charStart: body.indexOf("She"),
        });
        expect(mailPartAt(parts, -1)).toBeNull();
        expect(mailPartAt(parts, 99 * MAIL_PART_MS)).toBeNull();
        const range = mailRangeAt(parts, 0, 2 * MAIL_PART_MS - 1);
        expect(range).toMatchObject({ segmentIndex: 0, charStart: 0 });
        expect(body.slice(range?.charStart, range?.charEnd)).toBe(
            "Eva will lead the pilot at Acme.\n\nShe starts in November.",
        );
        // Across segments: the first part only.
        expect(
            mailRangeAt(parts, 2 * MAIL_PART_MS, 4 * MAIL_PART_MS),
        ).toMatchObject({
            segmentIndex: 0,
            charStart: body.indexOf("Thanks."),
        });
    });
});
