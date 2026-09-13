/**
 * Recovering speaker turns from a stored transcript.
 *
 * Transcripts are stored as one flat string. The diarizing providers write
 * `speaker: text` lines into it (see `format.ts`, `elevenlabs-transcribe.ts`
 * and `plaud/content.ts`), so the turns are recoverable, but only for
 * transcripts that were diarized in the first place.
 */

/** One speaker's uninterrupted turn. */
export interface SpeakerTurn {
    /** Raw label as stored, e.g. `speaker_0`. Identity, not display. */
    speaker: string;
    /** Display form of `speaker`, e.g. `Speaker 0`. */
    label: string;
    text: string;
}

export interface DiarizationSource {
    source?: string | null;
    model?: string | null;
}

/**
 * Longest plausible speaker label, in characters. Long enough for
 * `Speaker 10` or a name, short enough that a sentence opening with a colon
 * is not mistaken for one.
 */
const MAX_LABEL_LENGTH = 40;

/**
 * A label is a short run of word characters, spaces, dots, dashes or
 * underscores. Anything with sentence punctuation in it is prose.
 */
const TURN_PATTERN = new RegExp(
    `^([\\p{L}\\p{N} ._-]{1,${MAX_LABEL_LENGTH}}):[ \\t]+(\\S.*)$`,
    "u",
);

/**
 * True when this transcript was produced by a path that emits speaker labels.
 *
 * Deliberately keyed on the same `diarize` substring that `getResponseFormat`
 * uses to request diarization, so the display rule cannot drift away from the
 * request rule. Everything else is excluded: the Gemini and chat-style
 * prompts ask for no speaker labels at all, and plain Whisper has none to
 * give.
 *
 * This says diarization was REQUESTED, not that labels arrived -- a diarizing
 * model can return a single unlabelled block. Pair it with
 * `parseSpeakerTurns`, which answers the second question.
 */
export function mayBeDiarized({ source, model }: DiarizationSource): boolean {
    if (source === "plaud" || source === "mixed") return true;
    return (model ?? "").toLowerCase().includes("diarize");
}

/**
 * Split a transcript into speaker turns, or return null if it does not look
 * like a dialog after all.
 *
 * Returns null rather than a one-turn array when nothing is labelled, so the
 * caller can fall back to plain text instead of rendering a dialog with a
 * single anonymous participant.
 */
export function parseSpeakerTurns(text: string): SpeakerTurn[] | null {
    const lines = text.split("\n");
    const turns: SpeakerTurn[] = [];
    let labelled = 0;
    let unlabelled = 0;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const match = TURN_PATTERN.exec(line);
        if (match) {
            labelled++;
            const speaker = match[1].trim();
            const body = match[2].trim();
            const previous = turns.at(-1);
            if (previous && previous.speaker === speaker) {
                previous.text += `\n${body}`;
            } else {
                turns.push({
                    speaker,
                    label: formatSpeakerLabel(speaker),
                    text: body,
                });
            }
            continue;
        }

        unlabelled++;
        const previous = turns.at(-1);
        if (previous) {
            previous.text += `\n${line}`;
        } else {
            turns.push({ speaker: "", label: "", text: line });
        }
    }

    if (labelled === 0) return null;
    // A stray unlabelled line inside a dialog is normal; a transcript that is
    // mostly prose with the occasional `Note:` in it is not a dialog.
    if (unlabelled > labelled) return null;
    return turns;
}

/**
 * Display form of a stored speaker label: `speaker_0` becomes `Speaker 0`.
 *
 * Kept close to the original on purpose. Summaries quote these labels back
 * verbatim ("the speaker, speaker_0, explains..."), so renumbering or
 * renaming them would leave the summary referring to something the transcript
 * no longer shows.
 */
export function formatSpeakerLabel(speaker: string): string {
    const trimmed = speaker.trim();
    if (!trimmed) return "";
    const normalized = trimmed.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    if (normalized.length > MAX_LABEL_LENGTH) return trimmed;
    return normalized.replace(
        /^(speaker)\b/i,
        (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    );
}

/**
 * Distinct speakers in the order they first speak.
 *
 * Order of appearance rather than label text, so the first speaker is always
 * the first colour whether the provider called them `speaker_0`, `A` or
 * `Jana`.
 */
export function speakerOrder(turns: SpeakerTurn[]): string[] {
    const order: string[] = [];
    for (const turn of turns) {
        if (turn.speaker && !order.includes(turn.speaker)) {
            order.push(turn.speaker);
        }
    }
    return order;
}
