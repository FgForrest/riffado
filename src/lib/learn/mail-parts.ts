import type {
    ContentSegment,
    ItemContent,
    SegmentRole,
} from "@/lib/content/types";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/**
 * A mail as Learn reads a transcript, and back. Learn's passes and its
 * validation work on timed turns; a mail has none, so each part of it
 * stands at its own minute while Learn reads it. These two functions are
 * the only ones that know: review items and evidence carry the part's
 * place in the mail's text, never the minute.
 */

/** The time one part of a mail stands at while Learn reads it. */
export const MAIL_PART_MS = 60_000;

/** The label a part nobody is known to have written goes under. */
export const UNKNOWN_WRITER = "unknown";

/** Where one part Learn read stands in the mail's content. */
export interface MailPart {
    segmentIndex: number;
    /** UTF-16 offsets in the segment's text. */
    charStart: number;
    charEnd: number;
    role: SegmentRole;
    participantRef: string | null;
}

export interface MailParts {
    turns: TranscriptTurn[];
    parts: MailPart[];
}

/** A text's paragraphs (split at blank lines), trimmed, with their offsets. */
function paragraphsOf(text: string): { start: number; end: number }[] {
    const found: { start: number; end: number }[] = [];
    const pattern = /\S[\s\S]*?(?=\n[ \t]*\n|\s*$)/g;
    for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0;
        const end = start + match[0].trimEnd().length;
        if (end > start) found.push({ start, end });
    }
    return found;
}

function lead(segment: ContentSegment): string {
    switch (segment.role) {
        case "quoted":
            return segment.at
                ? `(quoted, written ${segment.at.toISOString().slice(0, 10)}) `
                : "(quoted) ";
        case "quoted_signature":
            return "(signature in a quoted message) ";
        case "signature":
            return "(signature) ";
        case "disclaimer":
            return "(disclaimer) ";
        default:
            return "";
    }
}

/**
 * The parts of a mail Learn reads, as turns: one per paragraph of its own
 * text and of each quoted part not already in the pile, one per signature
 * and disclaimer (those in `skip`, read before, left out). Its writer's
 * reference is the turn's label; a part's role leads its text.
 */
export function mailLearnParts(
    content: Pick<ItemContent, "segments">,
    { skip = new Set<number>() }: { skip?: ReadonlySet<number> } = {},
): MailParts {
    const turns: TranscriptTurn[] = [];
    const parts: MailPart[] = [];
    for (const segment of content.segments) {
        if (segment.knownItemId || skip.has(segment.index)) continue;
        const whole =
            segment.role === "signature" ||
            segment.role === "quoted_signature" ||
            segment.role === "disclaimer";
        const pieces = whole
            ? [{ start: 0, end: segment.text.length }]
            : paragraphsOf(segment.text);
        for (const piece of pieces) {
            const text = segment.text.slice(piece.start, piece.end).trim();
            if (!text) continue;
            const at = parts.length * MAIL_PART_MS;
            parts.push({
                segmentIndex: segment.index,
                charStart: piece.start,
                charEnd: piece.end,
                role: segment.role,
                participantRef: segment.participantRef,
            });
            turns.push({
                speaker: segment.participantRef ?? UNKNOWN_WRITER,
                startMs: at,
                endMs: at + MAIL_PART_MS - 1,
                text: `${lead(segment)}${text}`,
            });
        }
    }
    return { turns, parts };
}

/** The part a time of `mailLearnParts` stands for, or null. */
export function mailPartAt(
    parts: readonly MailPart[],
    ms: number,
): MailPart | null {
    if (!Number.isFinite(ms) || ms < 0) return null;
    return parts[Math.floor(ms / MAIL_PART_MS)] ?? null;
}

/**
 * The parts from one time to another of `mailLearnParts`: where a fact
 * said across several stands, as one range when they are of one segment.
 */
export function mailRangeAt(
    parts: readonly MailPart[],
    startMs: number,
    endMs: number,
): MailPart | null {
    const first = mailPartAt(parts, startMs);
    const last = mailPartAt(parts, endMs) ?? first;
    if (!first || !last) return null;
    if (last.segmentIndex !== first.segmentIndex) return first;
    return {
        ...first,
        charEnd: Math.max(first.charEnd, last.charEnd),
    };
}
