/**
 * One speaker's uninterrupted turn, as returned by a diarizing provider.
 *
 * `speaker` is the raw provider label (`speaker_0`, `S1`). It is identity,
 * never display: knowledge-base names are applied on top of it at render
 * time and the stored value never changes.
 */
export interface TranscriptTurn {
    speaker: string;
    startMs: number;
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
