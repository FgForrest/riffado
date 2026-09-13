/**
 * The SSE wire format for summary progress.
 *
 * The parser is the part worth testing hard: a `data:` frame is not
 * guaranteed to arrive whole, and a naive `JSON.parse` per chunk loses an
 * event whenever a read lands mid-frame — which is precisely the case that
 * never shows up on a fast local connection and always shows up eventually.
 */

import { describe, expect, it } from "vitest";
import {
    createStreamEventParser,
    encodeStreamEvent,
    formatElapsed,
    formatSummaryStatus,
    type SummaryStreamEvent,
} from "@/lib/summary/progress-stream";

const progress = (completed: number): SummaryStreamEvent => ({
    type: "progress",
    phase: "passes",
    completed,
    total: 3,
});

describe("createStreamEventParser", () => {
    it("round-trips an encoded event", () => {
        const parse = createStreamEventParser();
        expect(parse(encodeStreamEvent(progress(1)))).toEqual([progress(1)]);
    });

    it("reassembles a frame split across reads", () => {
        const wire = encodeStreamEvent(progress(2));
        const parse = createStreamEventParser();

        // Cut mid-JSON, the case a fast localhost connection never produces.
        const cut = Math.floor(wire.length / 2);
        expect(parse(wire.slice(0, cut))).toEqual([]);
        expect(parse(wire.slice(cut))).toEqual([progress(2)]);
    });

    it("emits every event when several arrive in one read", () => {
        const parse = createStreamEventParser();
        const wire =
            encodeStreamEvent(progress(1)) +
            encodeStreamEvent(progress(2)) +
            encodeStreamEvent(progress(3));

        expect(parse(wire)).toEqual([progress(1), progress(2), progress(3)]);
    });

    it("holds a trailing partial frame back rather than dropping it", () => {
        const parse = createStreamEventParser();
        const wire = `${encodeStreamEvent(progress(1))}data: {"type":"pro`;

        expect(parse(wire)).toEqual([progress(1)]);
        expect(
            parse('gress","phase":"passes","completed":2,"total":3}\n\n'),
        ).toEqual([progress(2)]);
    });

    it("skips a malformed frame instead of throwing", () => {
        const parse = createStreamEventParser();
        // A summary that otherwise succeeded is not worth failing over one
        // unparseable line.
        const wire = `data: not json\n\n${encodeStreamEvent(progress(1))}`;
        expect(parse(wire)).toEqual([progress(1)]);
    });

    it("ignores comment and field lines that are not data", () => {
        const parse = createStreamEventParser();
        expect(parse(": keep-alive\n\n")).toEqual([]);
        expect(parse("event: ping\n\n")).toEqual([]);
    });
});

describe("formatElapsed", () => {
    it("formats as m:ss", () => {
        expect(formatElapsed(0)).toBe("0:00");
        expect(formatElapsed(7_000)).toBe("0:07");
        expect(formatElapsed(72_000)).toBe("1:12");
        expect(formatElapsed(725_000)).toBe("12:05");
        // A clock that jumped backwards must not render "-1:-3".
        expect(formatElapsed(-5_000)).toBe("0:00");
    });
});

describe("formatSummaryStatus", () => {
    it("still shows a clock with no progress to report", () => {
        // The single-pass path emits no progress at all. Without the clock,
        // a slow run is indistinguishable from a hung one.
        expect(formatSummaryStatus(null, 12_000)).toBe(
            "Generating summary… · 0:12",
        );
    });

    it("counts completed passes", () => {
        expect(
            formatSummaryStatus(
                { phase: "passes", completed: 1, total: 3 },
                5_000,
            ),
        ).toBe("Summarizing — 1/3 passes · 0:05");
    });

    it("names the merge phase", () => {
        expect(
            formatSummaryStatus(
                { phase: "merging", completed: 3, total: 3 },
                61_000,
            ),
        ).toBe("Merging 3 passes… · 1:01");
    });

    it("omits the clock before the first tick", () => {
        expect(formatSummaryStatus(null, 0)).toBe("Generating summary…");
    });
});
