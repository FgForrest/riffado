import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiEnhancements, recordings, transcriptions } from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { isRecordingShared } from "@/lib/sharing/shared";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/**
 * Provenance of a transcript row, orthogonal to `transcriptionType`:
 *   - 'riffado' = produced by the user's own provider (server/browser)
 *   - 'plaud'   = imported from Plaud's native transcription
 *   - 'mixed'   = user-edited combination of the above
 * A recording can hold at most one row per source (enforced by the
 * `(recordingId, userId, source)` unique), so the sources coexist. See #204.
 */
export type TranscriptSource = "riffado" | "plaud" | "mixed";

/** Summary pipeline provenance. One row per source can coexist. */
export type EnhancementSource = "riffado" | "plaud";

export interface UpsertTranscriptionArgs {
    userId: string;
    recordingId: string;
    /** Plaintext transcript; this helper encrypts it at rest. */
    text: string;
    detectedLanguage: string | null;
    source: TranscriptSource;
    provider: string;
    model: string;
    /** Where it ran. Defaults to "server"; unrelated to `source`. */
    transcriptionType?: "server" | "browser";
    /**
     * Timed turns, encrypted at rest. Always written, including as
     * undefined, so a re-run without timings clears the previous run's turns
     * instead of leaving them beside text they no longer describe.
     */
    turns?: TranscriptTurn[];
    /** Permit an explicit user action to replace a deliberately erased transcript. */
    allowReaped?: boolean;
    /** Owner of the recording when it differs from the row owner (Organization view). */
    recordingOwnerId?: string;
    /** Account whose provider produced the text; defaults to `userId`. */
    producedByUserId?: string;
}

export interface UpsertEnhancementArgs {
    userId: string;
    recordingId: string;
    /** Transcript row this summary was generated from. */
    transcriptionId: string;
    /** Plaintext summary; this helper encrypts it at rest. */
    summary: string;
    keyPoints: string[];
    actionItems: string[];
    source: EnhancementSource;
    provider: string;
    model: string;
    /**
     * Multi-pass provenance, or undefined for a single-pass run.
     *
     * Written on every upsert, including as NULL: re-generating a
     * multi-pass summary in single-pass mode has to clear the old values,
     * or the row keeps claiming a provenance the current summary does not
     * have.
     */
    multiPass?: {
        roundsRequested: number;
        passesUsed: number;
        merged: boolean;
    };
    /** Permit an explicit user action to replace a deliberately erased summary. */
    allowReaped?: boolean;
    /** Owner of the recording when it differs from the row owner (Organization view). */
    recordingOwnerId?: string;
    /** Account whose provider produced the summary; defaults to `userId`. */
    producedByUserId?: string;
}

/**
 * Result of a tombstone-aware upsert. `committed: false` means the recording
 * was soft-deleted mid-flight and nothing was written — callers should treat
 * that as a skip (e.g. RECORDING_DELETED), not a hard error.
 */
export interface UpsertResult {
    committed: boolean;
}

const RECORDING_WRITE_BLOCKED = Symbol("recording-write-blocked");

// Both upserts run inside a transaction that takes a row-level write lock
// (`FOR UPDATE`) on the recording and re-checks the soft-delete tombstone, so
// a concurrent DELETE can't be silently undone: either we see `deletedAt` set
// and abort, or our write commits before DELETE runs and DELETE then cleans up
// our row inside its own tx. Lifted verbatim from the transcribe + summary
// paths so all writers share one implementation. See PR #72.

/**
 * Insert-or-update the transcription row for `(recordingId, userId, source)`.
 * Source-scoped, so a Plaud-imported transcript and the user's own provider's
 * output upsert independently and coexist.
 */
export async function upsertTranscription(
    args: UpsertTranscriptionArgs,
): Promise<UpsertResult> {
    const {
        userId,
        recordingId,
        text,
        detectedLanguage,
        source,
        provider,
        model,
        transcriptionType = "server",
        turns,
        allowReaped = false,
    } = args;
    const ownerId = args.recordingOwnerId ?? userId;
    const orgView = ownerId !== userId;
    const producedByUserId = args.producedByUserId ?? userId;

    try {
        await db.transaction(async (tx) => {
            const [stillActive] = await tx
                .select({
                    deletedAt: recordings.deletedAt,
                    transcriptReapedAt: recordings.transcriptReapedAt,
                })
                .from(recordings)
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, ownerId),
                    ),
                )
                .for("update")
                .limit(1);

            // The owner's retention marker describes the owner's rows; the
            // Organization view is instead gated on still being shared, so a
            // run that outlives an unshare writes nothing.
            if (
                !stillActive ||
                stillActive.deletedAt ||
                (!orgView && stillActive.transcriptReapedAt && !allowReaped) ||
                (orgView && !(await isRecordingShared(recordingId, userId, tx)))
            ) {
                throw RECORDING_WRITE_BLOCKED;
            }

            const [current] = await tx
                .select({ id: transcriptions.id })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, recordingId),
                        eq(transcriptions.userId, userId),
                        eq(transcriptions.source, source),
                    ),
                )
                .limit(1);

            const encryptedText = encryptText(text);
            const encryptedTurns = turns?.length
                ? encryptJsonField(turns)
                : null;

            if (current) {
                await tx
                    .update(transcriptions)
                    .set({
                        text: encryptedText,
                        turns: encryptedTurns,
                        // Anchored to the turns just replaced.
                        topics: null,
                        detectedLanguage,
                        transcriptionType,
                        provider,
                        model,
                        source,
                        producedByUserId,
                    })
                    .where(
                        and(
                            eq(transcriptions.id, current.id),
                            eq(transcriptions.userId, userId),
                        ),
                    );
            } else {
                await tx.insert(transcriptions).values({
                    recordingId,
                    userId,
                    text: encryptedText,
                    turns: encryptedTurns,
                    topics: null,
                    detectedLanguage,
                    transcriptionType,
                    provider,
                    model,
                    source,
                    producedByUserId,
                });
            }

            if (!orgView) {
                await tx
                    .update(recordings)
                    .set({
                        updatedAt: new Date(),
                        transcriptReapedAt: null,
                    })
                    .where(
                        and(
                            eq(recordings.id, recordingId),
                            eq(recordings.userId, userId),
                        ),
                    );
            }
        });
    } catch (txError) {
        if (txError === RECORDING_WRITE_BLOCKED) {
            return { committed: false };
        }
        throw txError;
    }

    return { committed: true };
}

/**
 * Insert-or-update the single AI summary row for `(recordingId, userId)`.
 * `source` records whether riffado generated it or it was imported from Plaud.
 */
export async function upsertEnhancement(
    args: UpsertEnhancementArgs,
): Promise<UpsertResult> {
    const {
        userId,
        recordingId,
        transcriptionId,
        summary,
        keyPoints,
        actionItems,
        source,
        provider,
        model,
        multiPass,
        allowReaped = false,
    } = args;
    const ownerId = args.recordingOwnerId ?? userId;
    const orgView = ownerId !== userId;
    const producedByUserId = args.producedByUserId ?? userId;

    try {
        await db.transaction(async (tx) => {
            const [stillActive] = await tx
                .select({
                    deletedAt: recordings.deletedAt,
                    summaryReapedAt: recordings.summaryReapedAt,
                })
                .from(recordings)
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, ownerId),
                    ),
                )
                .for("update")
                .limit(1);

            if (
                !stillActive ||
                stillActive.deletedAt ||
                (!orgView && stillActive.summaryReapedAt && !allowReaped) ||
                (orgView && !(await isRecordingShared(recordingId, userId, tx)))
            ) {
                throw RECORDING_WRITE_BLOCKED;
            }

            const [existing] = await tx
                .select({ id: aiEnhancements.id })
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.recordingId, recordingId),
                        eq(aiEnhancements.userId, userId),
                        eq(aiEnhancements.source, source),
                    ),
                )
                .limit(1);

            // Always written, NULL included -- see `multiPass` on the args.
            const multiPassColumns = {
                multiPassRounds: multiPass?.roundsRequested ?? null,
                multiPassUsed: multiPass?.passesUsed ?? null,
                multiPassMerged: multiPass?.merged ?? null,
            };

            const encryptedSummary = encryptText(summary);
            const encryptedKeyPoints = encryptJsonField(keyPoints);
            const encryptedActionItems = encryptJsonField(actionItems);

            if (existing) {
                await tx
                    .update(aiEnhancements)
                    .set({
                        summary: encryptedSummary,
                        keyPoints: encryptedKeyPoints,
                        actionItems: encryptedActionItems,
                        transcriptionId,
                        provider,
                        model,
                        source,
                        producedByUserId,
                        ...multiPassColumns,
                    })
                    .where(
                        and(
                            eq(aiEnhancements.id, existing.id),
                            eq(aiEnhancements.userId, userId),
                        ),
                    );
            } else {
                await tx.insert(aiEnhancements).values({
                    recordingId,
                    userId,
                    transcriptionId,
                    summary: encryptedSummary,
                    keyPoints: encryptedKeyPoints,
                    actionItems: encryptedActionItems,
                    provider,
                    model,
                    source,
                    producedByUserId,
                    ...multiPassColumns,
                });
            }

            if (!orgView) {
                await tx
                    .update(recordings)
                    .set({
                        updatedAt: new Date(),
                        summaryReapedAt: null,
                    })
                    .where(
                        and(
                            eq(recordings.id, recordingId),
                            eq(recordings.userId, userId),
                        ),
                    );
            }
        });
    } catch (txError) {
        if (txError === RECORDING_WRITE_BLOCKED) {
            return { committed: false };
        }
        throw txError;
    }

    return { committed: true };
}
