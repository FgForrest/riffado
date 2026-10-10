import type { ChatterItemKind } from "@/db/schema";

/**
 * What a participant is to an item. A speaker of a recording; the sender,
 * a recipient or the claimed author of a quoted part of a mail.
 */
export type ParticipantRole =
    | "speaker"
    | "from"
    | "sender"
    | "to"
    | "cc"
    | "reply_to"
    | "quoted_author";

/**
 * Someone an item's content is by or to, under an opaque reference: a
 * diarized speaker label (`speaker_0`) or a mail participant (`p1`). The
 * reference, never the name or address, is what prompts, stored task
 * proposals and evidence carry.
 */
export interface ContentParticipant {
    ref: string;
    roles: readonly ParticipantRole[];
    /** Decrypted; null when unknown (an unresolved speaker). */
    displayName: string | null;
    /** A mail participant's address, decrypted; never logged. */
    address?: string | null;
    /** The address was proven by the sender's DKIM signature. */
    authenticated?: boolean;
    /** The owner's person this participant's address belongs to. */
    personId?: string | null;
}

/**
 * What a segment of content is: a recording's turn (`spoken`), or a part of
 * a mail. Only `spoken`, `body` and `quoted` carry what was said or written
 * in the item; the rest describe who wrote it.
 */
export type SegmentRole =
    | "spoken"
    | "body"
    | "signature"
    | "quoted"
    | "quoted_signature"
    | "disclaimer";

/** One piece of an item's content, in reading order. */
export interface ContentSegment {
    index: number;
    role: SegmentRole;
    /** The participant who said or wrote it; null when nobody is known. */
    participantRef: string | null;
    /** Quote nesting: 0 for a recording's turns and a mail's own text. */
    depth: number;
    /** When it was written, as claimed (a quoted part's header). */
    at: Date | null;
    /** A recording's turn: milliseconds into the audio. */
    startMs?: number;
    endMs?: number;
    text: string;
    /**
     * An item already in the pile this quoted part repeats; its text is
     * then not read again.
     */
    knownItemId?: string | null;
}

/**
 * Where something was said: a stretch of a recording's audio, or a range of
 * one segment's text (UTF-16 offsets, as JavaScript slices it).
 */
export type ContentAnchor =
    | { kind: "time"; startMs: number; endMs: number }
    | {
          kind: "text";
          segmentIndex: number;
          charStart: number;
          charEnd: number;
      };

/**
 * An item's content in one shape for every kind: who takes part, and what
 * they said or wrote. Summaries, tasks and Learn read this; storage stays
 * per kind (`transcriptions` for audio, `mail_contents` for mail).
 */
export interface ItemContent {
    itemId: string;
    kind: ChatterItemKind;
    /**
     * The row it was read from: a transcription for audio, a mail content
     * revision for mail.
     */
    sourceId: string;
    /** Moves on every rewrite of the content; anchors name it. */
    revision: number;
    language: string | null;
    participants: ContentParticipant[];
    segments: ContentSegment[];
}

/** Whether a segment carries what was said or written in the item itself. */
export function isSubstantive(segment: ContentSegment): boolean {
    return (
        segment.role === "spoken" ||
        segment.role === "body" ||
        segment.role === "quoted"
    );
}

/** The anchor's well-formedness, independent of any content. */
export function isValidAnchor(anchor: ContentAnchor): boolean {
    if (anchor.kind === "time") {
        return (
            Number.isInteger(anchor.startMs) &&
            Number.isInteger(anchor.endMs) &&
            anchor.startMs >= 0 &&
            anchor.startMs <= anchor.endMs
        );
    }
    return (
        Number.isInteger(anchor.segmentIndex) &&
        Number.isInteger(anchor.charStart) &&
        Number.isInteger(anchor.charEnd) &&
        anchor.segmentIndex >= 0 &&
        anchor.charStart >= 0 &&
        anchor.charStart < anchor.charEnd
    );
}

/** The words a text anchor covers, or null when they are not there. */
export function textAt(
    content: Pick<ItemContent, "segments">,
    anchor: Extract<ContentAnchor, { kind: "text" }>,
): string | null {
    const segment = content.segments[anchor.segmentIndex];
    if (!segment || anchor.charEnd > segment.text.length) return null;
    return segment.text.slice(anchor.charStart, anchor.charEnd);
}
