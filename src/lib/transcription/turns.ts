/**
 * One speaker's uninterrupted turn, as returned by a diarizing provider.
 *
 * `speaker` is the raw provider label (`speaker_0`, `S1`). It is identity,
 * never display: knowledge-base names are applied on top of it at render
 * time and the stored value never changes.
 */
export interface TranscriptTurn {
    speaker: string;
    /** Milliseconds from the start of the recording audio, once normalized here. */
    startMs: number;
    /** Milliseconds from the start of the recording audio, once normalized here. */
    endMs: number;
    text: string;
}

/** Resolves a raw speaker label to a display name, or null to keep the label. */
export type SpeakerNameResolver = (speaker: string) => string | null;

/** A provider segment before consecutive same-speaker runs are merged. */
export interface LabelledSegment {
    speaker: string;
    startMs: number;
    endMs: number;
    text: string;
}

/**
 * Render turns as the flat `speaker: text` transcript Riffado stores and
 * displays.
 *
 * The resolver is the single seam through which knowledge-base names reach
 * any output, so stored transcript text is never rewritten to apply a name.
 */
export function renderTurnsAsText(
    turns: readonly TranscriptTurn[],
    resolve?: SpeakerNameResolver,
): string {
    const lines: string[] = [];

    for (const turn of turns) {
        const body = turn.text.trim();
        if (!body) continue;
        if (!turn.speaker) {
            lines.push(body);
            continue;
        }
        lines.push(`${resolve?.(turn.speaker) ?? turn.speaker}: ${body}`);
    }

    return lines.join("\n");
}

/**
 * Merge provider segments into turns, joining consecutive runs by the same
 * speaker and widening each turn's span to cover the segments it absorbed.
 *
 * Returns null when nothing usable survives, so a caller can fall back to
 * an undiarized transcript rather than storing an empty turn list that
 * would render as a dialog with no participants.
 */
export function turnsFromLabelledSegments(
    segments: readonly LabelledSegment[],
): TranscriptTurn[] | null {
    const turns: TranscriptTurn[] = [];

    for (const segment of segments) {
        const text = segment.text.trim();
        if (!text) continue;

        const previous = turns.at(-1);
        if (previous && previous.speaker === segment.speaker) {
            previous.text = `${previous.text} ${text}`;
            previous.endMs = Math.max(previous.endMs, segment.endMs);
            continue;
        }

        turns.push({
            speaker: segment.speaker,
            startMs: segment.startMs,
            endMs: segment.endMs,
            text,
        });
    }

    return turns.length > 0 ? turns : null;
}

/** A pause at least this long starts a new paragraph. */
const PARAGRAPH_PAUSE_MS = 1500;
/** Past this length a paragraph ends at the next sentence end. */
const PARAGRAPH_SOFT_MAX_MS = 30_000;
/** Past this length a paragraph ends even mid-sentence. */
const PARAGRAPH_HARD_MAX_MS = 60_000;

const SENTENCE_END = /[.!?…]["'”»)\]]*$/;

/**
 * Group an undiarized provider's timed segments into speakerless turns, one
 * per paragraph.
 *
 * Whisper-style segments are a sentence or two each: stored as they come,
 * they read as a column of fragments, and a topic or a seek could only land
 * on the whole transcript if they were merged into one. So consecutive
 * segments join until a pause, or until the paragraph has grown long enough
 * to end at the next sentence. `turnsFromLabelledSegments` cannot do this:
 * every segment here carries the same empty label, and it would merge them
 * all into a single turn.
 *
 * Returns null when nothing usable survives, like `turnsFromLabelledSegments`.
 */
export function paragraphsFromTimedSegments(
    segments: readonly { startMs: number; endMs: number; text: string }[],
): TranscriptTurn[] | null {
    const paragraphs: TranscriptTurn[] = [];

    for (const segment of segments) {
        const text = segment.text.trim();
        if (!text) continue;

        const previous = paragraphs.at(-1);
        if (previous) {
            const length = previous.endMs - previous.startMs;
            const endsParagraph =
                segment.startMs - previous.endMs >= PARAGRAPH_PAUSE_MS ||
                length >= PARAGRAPH_HARD_MAX_MS ||
                (length >= PARAGRAPH_SOFT_MAX_MS &&
                    SENTENCE_END.test(previous.text));
            if (!endsParagraph) {
                previous.text = `${previous.text} ${text}`;
                previous.endMs = Math.max(previous.endMs, segment.endMs);
                continue;
            }
        }

        paragraphs.push({
            speaker: "",
            startMs: segment.startMs,
            endMs: segment.endMs,
            text,
        });
    }

    return paragraphs.length > 0 ? paragraphs : null;
}
