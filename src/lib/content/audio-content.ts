import type { ContentSegment, ItemContent } from "@/lib/content/types";
import { decryptText } from "@/lib/encryption/fields";
import { parseSpeakerTurns } from "@/lib/transcription/diarization";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/** The transcription columns audio content is read from. */
export interface AudioContentSource {
    id: string;
    recordingId: string;
    text: string;
    turns?: unknown;
    revision: number;
    detectedLanguage: string | null;
}

/**
 * A recording's content from one of its transcripts: one `spoken` segment
 * per turn, its speaker label as the participant reference. Timed turns
 * keep their times; a transcript without stored turns is split by its
 * `speaker: text` lines, untimed, as the transcript view reads it.
 */
export function audioContentFrom(source: AudioContentSource): ItemContent {
    const turns = readTranscriptTurns(source);
    const segments: ContentSegment[] = turns
        ? turns.map(timedSegment)
        : untimedSegments(decryptText(source.text));
    const refs = [
        ...new Set(
            segments
                .map((segment) => segment.participantRef)
                .filter((ref): ref is string => ref !== null),
        ),
    ];
    return {
        itemId: source.recordingId,
        kind: "audio",
        sourceId: source.id,
        revision: source.revision,
        language: source.detectedLanguage,
        participants: refs.map((ref) => ({
            ref,
            roles: ["speaker"],
            displayName: null,
        })),
        segments,
    };
}

function timedSegment(turn: TranscriptTurn, index: number): ContentSegment {
    return {
        index,
        role: "spoken",
        participantRef: turn.speaker || null,
        depth: 0,
        at: null,
        startMs: turn.startMs,
        endMs: turn.endMs,
        text: turn.text,
    };
}

function untimedSegments(text: string): ContentSegment[] {
    const turns = parseSpeakerTurns(text);
    if (!turns) {
        const body = text.trim();
        return body
            ? [
                  {
                      index: 0,
                      role: "spoken",
                      participantRef: null,
                      depth: 0,
                      at: null,
                      text: body,
                  },
              ]
            : [];
    }
    return turns.map((turn, index) => ({
        index,
        role: "spoken",
        participantRef: turn.speaker || null,
        depth: 0,
        at: null,
        text: turn.text,
    }));
}
