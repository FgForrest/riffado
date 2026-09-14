import { decryptJsonField } from "@/lib/encryption/fields";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/** The shape every transcript reader already selects, narrowed to what matters. */
export interface TurnsBearingRow {
    turns?: unknown;
}

/**
 * Decrypt a transcription row's stored turns.
 *
 * Returns null for a transcript that carries none -- an undiarized provider,
 * or any transcript written before turns were persisted -- so callers fall
 * back to `parseSpeakerTurns` over the flat text rather than rendering an
 * empty dialog.
 */
export function readTranscriptTurns(
    row: TurnsBearingRow | null | undefined,
): TranscriptTurn[] | null {
    if (!row || row.turns === null || row.turns === undefined) return null;
    const turns = decryptJsonField<TranscriptTurn[]>(row.turns);
    return Array.isArray(turns) && turns.length > 0 ? turns : null;
}
