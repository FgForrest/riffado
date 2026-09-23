/**
 * The timeline a topic can be anchored to: time marks drawn from a
 * transcript's timed turns.
 *
 * A topic is only as good as its start time, and a model asked for times
 * invents plausible ones. So the model never produces a time of its own: it
 * reads the transcript with a time printed at the start of every line and
 * answers with one of those times, which `anchorTopics` then snaps back onto
 * this timeline. Everything here is pure, and shared by the generator and
 * the transcript view.
 */

import { formatSpeakerLabel } from "@/lib/transcription/diarization";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/** One chapter of a transcript. */
export interface TranscriptTopic {
    title: string;
    /** Milliseconds from the start of the recording audio. */
    fromMs: number;
    /** The next topic's `fromMs`, or the end of the last turn. */
    toMs: number;
}

/** A point a topic may start at, and the line of transcript it heads. */
export interface TimeMark {
    ms: number;
    turnIndex: number;
    /** Set on the first mark of a turn; continuation marks have none. */
    speaker: string | null;
    text: string;
}

/** A turn longer than this gets extra marks inside it. */
const LONG_TURN_MS = 60_000;
/** Marks inside a long turn are at least this far apart. */
const MIN_MARK_SPACING_MS = 15_000;

const SENTENCE_BREAK = /(?<=[.!?…]["'”»)\]]*)\s+/u;

/**
 * Time marks for every turn: one at its start, and for a long turn more at
 * sentence boundaries inside it.
 *
 * A diarized turn is one speaker's uninterrupted run, and a Plaud monologue
 * can run for minutes. With a mark only at its start, a topic beginning
 * halfway through could only be placed at the start of the turn, and clicking
 * it would play the end of the previous topic first. The inner marks are
 * interpolated by character position -- speech rate is not constant, so they
 * can be a few seconds off, which is close enough to start listening.
 */
export function buildTimeMarks(turns: readonly TranscriptTurn[]): TimeMark[] {
    const marks: TimeMark[] = [];

    turns.forEach((turn, turnIndex) => {
        const text = turn.text.replace(/\s+/g, " ").trim();
        if (!text) return;
        const speaker = formatSpeakerLabel(turn.speaker);
        const duration = turn.endMs - turn.startMs;

        if (duration <= LONG_TURN_MS) {
            marks.push({ ms: turn.startMs, turnIndex, speaker, text });
            return;
        }

        const sentences = text.split(SENTENCE_BREAK);
        let offset = 0;
        let chunk: { ms: number; text: string } | null = null;
        for (const sentence of sentences) {
            const ms =
                turn.startMs + Math.round((offset / text.length) * duration);
            offset += sentence.length + 1;
            if (chunk && ms - chunk.ms < MIN_MARK_SPACING_MS) {
                chunk.text = `${chunk.text} ${sentence}`;
                continue;
            }
            if (chunk) {
                marks.push({
                    ms: chunk.ms,
                    turnIndex,
                    speaker:
                        marks.at(-1)?.turnIndex === turnIndex ? null : speaker,
                    text: chunk.text,
                });
            }
            chunk = { ms, text: sentence };
        }
        if (chunk) {
            marks.push({
                ms: chunk.ms,
                turnIndex,
                speaker: marks.at(-1)?.turnIndex === turnIndex ? null : speaker,
                text: chunk.text,
            });
        }
    });

    return marks;
}

/** `mm:ss`, or `h:mm:ss` past the hour. The form the model reads and answers with. */
export function formatClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
        : `${String(minutes).padStart(2, "0")}:${seconds}`;
}

/** Milliseconds for `m:ss` or `h:mm:ss`, or null for anything else. */
export function parseClock(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const match = /^\s*\[?(?:(\d+):)?(\d{1,3}):(\d{2})\]?\s*$/.exec(value);
    if (!match) return null;
    const [, hours, minutes, seconds] = match;
    if (Number(seconds) >= 60) return null;
    return (
        ((Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)) *
        1000
    );
}

/**
 * The transcript as the model reads it: one mark per line, its time first.
 * A line without a speaker continues the previous line's speaker.
 */
export function renderTimedTranscript(marks: readonly TimeMark[]): string {
    return marks
        .map((mark) =>
            mark.speaker
                ? `[${formatClock(mark.ms)}] ${mark.speaker}: ${mark.text}`
                : `[${formatClock(mark.ms)}] ${mark.text}`,
        )
        .join("\n");
}

/** A contiguous run of marks sent in one request. */
export interface MarkWindow {
    marks: TimeMark[];
    /** Topics from this window are kept from here on; see `joinWindowTopics`. */
    keepFromMs: number;
}

/**
 * Split marks into windows of at most `maxChars` rendered characters, each
 * overlapping the previous one by about `overlapChars`.
 *
 * The overlap is what lets a topic that straddles a window boundary be
 * seen whole by at least one request. Each window keeps its topics only from
 * the middle of its overlap with the previous window on, and the previous
 * window keeps them only up to that point, so every stretch of the
 * transcript is decided by exactly one window.
 */
export function splitIntoWindows(
    marks: readonly TimeMark[],
    maxChars: number,
    overlapChars: number,
): MarkWindow[] {
    const lengths = marks.map(
        (mark) => renderTimedTranscript([mark]).length + 1,
    );
    const windows: MarkWindow[] = [];
    let start = 0;

    while (start < marks.length) {
        let end = start;
        let size = 0;
        while (
            end < marks.length &&
            (end === start || size + lengths[end] <= maxChars)
        ) {
            size += lengths[end];
            end++;
        }

        let keepFromMs = Number.NEGATIVE_INFINITY;
        if (windows.length > 0) {
            // `start` was pulled back into the previous window; the handover
            // point is the middle of the shared stretch.
            const previous = windows.at(-1) as MarkWindow;
            const lastShared = previous.marks.at(-1) as TimeMark;
            keepFromMs = Math.round((marks[start].ms + lastShared.ms) / 2);
        }
        windows.push({ marks: marks.slice(start, end), keepFromMs });
        if (end >= marks.length) break;

        let back = end;
        let overlap = 0;
        while (
            back - 1 > start &&
            overlap + lengths[back - 1] <= overlapChars
        ) {
            back--;
            overlap += lengths[back];
        }
        start = back;
    }

    return windows;
}

/** Index of the turn a moment falls in: the last one starting at or before it. */
export function containingTurnIndex(
    turns: readonly Pick<TranscriptTurn, "startMs">[],
    ms: number,
): number {
    let found = 0;
    for (let i = 0; i < turns.length; i++) {
        if (turns[i].startMs <= ms) found = i;
        else break;
    }
    return found;
}

/** Index of the topic being played at `ms`, or -1 before the first one. */
export function activeTopicIndex(
    topics: readonly TranscriptTopic[],
    ms: number,
): number {
    let found = -1;
    for (let i = 0; i < topics.length; i++) {
        if (topics[i].fromMs <= ms) found = i;
        else break;
    }
    return found;
}
