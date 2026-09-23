/**
 * Turning a model's reply into topics anchored on the transcript's timeline.
 *
 * The reply is untrusted: the model may wrap it in a code fence, answer with
 * a time it was not given, repeat itself or run past the end. Nothing it says
 * reaches storage except as a title attached to one of our own time marks.
 */

import type { MarkWindow, TimeMark, TranscriptTopic } from "./timeline";
import { parseClock } from "./timeline";

/** A topic as the model proposed it, before anchoring. */
export interface TopicCandidate {
    start: unknown;
    title: unknown;
}

/** More than this many topics is no longer a table of contents. */
export const MAX_TOPICS = 50;
const MAX_TITLE_LENGTH = 80;

/**
 * The `topics` array of a reply, or null when the reply holds none.
 * Tolerates a code fence and text around the JSON, and a bare array.
 */
export function parseTopicsReply(raw: string): TopicCandidate[] | null {
    const text = raw
        .replace(/^\s*```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "");
    const candidates = [text];
    const objectStart = text.indexOf("{");
    const objectEnd = text.lastIndexOf("}");
    if (objectStart !== -1 && objectEnd > objectStart) {
        candidates.push(text.slice(objectStart, objectEnd + 1));
    }
    const arrayStart = text.indexOf("[");
    const arrayEnd = text.lastIndexOf("]");
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
        candidates.push(text.slice(arrayStart, arrayEnd + 1));
    }

    for (const candidate of candidates) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(candidate);
        } catch {
            continue;
        }
        const list = Array.isArray(parsed)
            ? parsed
            : (parsed as { topics?: unknown } | null)?.topics;
        if (Array.isArray(list)) {
            return list.filter(
                (entry): entry is TopicCandidate =>
                    typeof entry === "object" && entry !== null,
            );
        }
    }
    return null;
}

function cleanTitle(value: unknown): string {
    if (typeof value !== "string") return "";
    const title = value
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^["'„“”«»]+|["'„“”«»]+$/g, "")
        .trim();
    return title.length > MAX_TITLE_LENGTH
        ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
        : title;
}

/** The mark nearest to `ms`; the earlier one on a tie. */
function nearestMark(marks: readonly TimeMark[], ms: number): TimeMark {
    let best = marks[0];
    for (const mark of marks) {
        if (Math.abs(mark.ms - ms) < Math.abs(best.ms - ms)) best = mark;
    }
    return best;
}

/**
 * Snap proposed topics onto the marks the model was shown.
 *
 * A start is parsed as a clock time and moved to the nearest mark, so a
 * slightly misquoted time still lands on a real line of the transcript. A
 * start that does not parse, or lies past the last mark's turn, is dropped,
 * as is a topic without a title. Topics come back in time order, one per
 * mark: the first title for a mark wins. `toMs` is left at 0 here and set by
 * `finishTopics` once all windows are joined.
 */
export function anchorTopics(
    candidates: readonly TopicCandidate[],
    marks: readonly TimeMark[],
    endMs: number,
): TranscriptTopic[] {
    if (marks.length === 0) return [];
    const byMark = new Map<number, TranscriptTopic>();
    for (const candidate of candidates) {
        const title = cleanTitle(candidate.title);
        const ms = parseClock(candidate.start);
        if (!title || ms === null || ms > endMs) continue;
        const mark = nearestMark(marks, ms);
        if (!byMark.has(mark.ms)) {
            byMark.set(mark.ms, { title, fromMs: mark.ms, toMs: 0 });
        }
    }
    return [...byMark.values()].sort((a, b) => a.fromMs - b.fromMs);
}

/**
 * Join the topics of consecutive windows: each window decides the stretch
 * from its own `keepFromMs` up to the next window's.
 */
export function joinWindowTopics(
    windows: readonly MarkWindow[],
    topicsPerWindow: readonly TranscriptTopic[][],
): TranscriptTopic[] {
    const joined: TranscriptTopic[] = [];
    windows.forEach((window, index) => {
        const until =
            windows[index + 1]?.keepFromMs ?? Number.POSITIVE_INFINITY;
        for (const topic of topicsPerWindow[index] ?? []) {
            if (topic.fromMs >= window.keepFromMs && topic.fromMs < until) {
                joined.push(topic);
            }
        }
    });
    return joined;
}

/**
 * Close each topic at the next one's start and the last at `endMs`, merge
 * neighbours that ended up with the same title, and cap the count.
 */
export function finishTopics(
    topics: readonly TranscriptTopic[],
    endMs: number,
): TranscriptTopic[] {
    const merged: TranscriptTopic[] = [];
    for (const topic of topics) {
        const previous = merged.at(-1);
        if (
            previous &&
            previous.title.toLocaleLowerCase() ===
                topic.title.toLocaleLowerCase()
        ) {
            continue;
        }
        merged.push({ ...topic });
    }
    const capped = merged.slice(0, MAX_TOPICS);
    return capped.map((topic, index) => ({
        ...topic,
        toMs: Math.max(topic.fromMs, capped[index + 1]?.fromMs ?? endMs),
    }));
}

/** Shape check for a stored or received topic list. */
export function isTopicList(value: unknown): value is TranscriptTopic[] {
    return (
        Array.isArray(value) &&
        value.every(
            (topic) =>
                typeof topic === "object" &&
                topic !== null &&
                typeof topic.title === "string" &&
                Number.isFinite(topic.fromMs) &&
                Number.isFinite(topic.toMs),
        )
    );
}
