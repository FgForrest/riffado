import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin, touchRecording } from "@/db/items";
import {
    aiEnhancements,
    asyncJobs,
    type ChatterItemKind,
    chatterItems,
    recordings,
    transcriptions,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { speakerVersionOf } from "@/lib/knowledge/speaker-label-rules";
import { storedSpeakerVersion } from "@/lib/knowledge/speaker-labels";
import {
    stampNewTranscriptAudioInTx,
    transcriptRewrittenInTx,
} from "@/lib/knowledge/transcript-rewrite";
import {
    contentWriterRefusal,
    sharingOrgUserId,
    type WriterRefusal,
} from "@/lib/sharing/writer";
import { type TaskProposals, writeTaskProposalsInTx } from "@/lib/tasks/store";
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
    /** The recording's owner, who owns its content rows. */
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
    /**
     * The summary source made from the text this write replaces, deleted
     * with it in the same transaction, so it never outlives its text nor
     * goes after the writer lost the right to change the recording.
     */
    dropSummaryOnReplace?: EnhancementSource;
    /**
     * Who makes the change; defaults to `userId`. The organization account
     * on a shared recording, the owner otherwise (see `writerRefusal`).
     */
    actorUserId?: string;
    /** Account whose provider produced the text; defaults to the actor. */
    producedByUserId?: string;
    /**
     * The job this write finishes. Cancelled meanwhile (the recording was
     * withdrawn, erased or deleted), it writes nothing, even if the
     * recording is shared again by then.
     */
    /**
     * The md5 of the audio this text was made from, as read when its
     * transcription began (a sync may replace the audio meanwhile); the
     * recording's current one by default.
     */
    audioMd5?: string | null;
    jobId?: string;
}

export interface UpsertEnhancementArgs {
    /** The recording's owner, who owns its content rows. */
    userId: string;
    recordingId: string;
    /** The item's kind; a recording unless said otherwise. */
    kind?: ChatterItemKind;
    /** Transcript row this summary was generated from; null for mail. */
    transcriptionId: string | null;
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
    /**
     * `llmInputFingerprint` of what the model read; null (or absent) for a
     * summary nobody can tell stale, as an import. Written on every upsert.
     */
    inputFingerprint?: string | null;
    /** Permit an explicit user action to replace a deliberately erased summary. */
    allowReaped?: boolean;
    /** Who makes the change; defaults to `userId`. See `UpsertTranscriptionArgs`. */
    actorUserId?: string;
    /** Account whose provider produced the summary; defaults to the actor. */
    producedByUserId?: string;
    /** See `UpsertTranscriptionArgs.jobId`. */
    jobId?: string;
    /**
     * The task proposals the summary made, stored with it in its
     * transaction: they replace the ones its source made before.
     */
    tasks?: TaskProposals;
}

/**
 * Result of a tombstone-aware upsert. `committed: false` means nothing was
 * written — callers should treat that as a skip, not a hard error:
 * - `reason: "shared"`: the recording is shared with the Organization and
 *   only the organization account changes it (RECORDING_SHARED);
 * - `reason: "withdrawn"`: an Organization change, and the recording is no
 *   longer shared;
 * - `reason: "cancelled"`: the job it finishes was cancelled meanwhile;
 * - otherwise it was soft-deleted mid-flight or its content erased (e.g.
 *   RECORDING_DELETED).
 */
export interface UpsertResult {
    committed: boolean;
    reason?: WriterRefusal | "cancelled";
}

const RECORDING_WRITE_BLOCKED = Symbol("recording-write-blocked");

class WriterRefused {
    constructor(readonly refusal: WriterRefusal | "cancelled") {}
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Whether the job a write finishes is still running. A cancellation marks
 * it failed under the same recording lock, so this is the job's state as of
 * that lock.
 */
async function jobStillRunning(tx: Tx, jobId: string): Promise<boolean> {
    const [job] = await tx
        .select({ status: asyncJobs.status })
        .from(asyncJobs)
        .where(eq(asyncJobs.id, jobId))
        .limit(1);
    return job?.status === "processing";
}

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
    const actorUserId = args.actorUserId ?? userId;
    const producedByUserId = args.producedByUserId ?? actorUserId;
    // Before the transaction; see `sharingOrgUserId`.
    const orgUserId = await sharingOrgUserId();

    try {
        await db.transaction(async (tx) => {
            const [stillActive] = await tx
                .select({
                    deletedAt: recordings.deletedAt,
                    transcriptReapedAt: chatterItems.contentReapedAt,
                })
                .from(recordings)
                .innerJoin(chatterItems, recordingItemJoin)
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                    ),
                )
                .for("update")
                .limit(1);

            if (
                !stillActive ||
                stillActive.deletedAt ||
                (stillActive.transcriptReapedAt && !allowReaped)
            ) {
                throw RECORDING_WRITE_BLOCKED;
            }
            // From every writer: a provider run, a browser transcript, a
            // Plaud import. Under the lock sharing and withdrawal take, so
            // a run that began before either and ends after it writes
            // nothing.
            const refusal = await contentWriterRefusal(tx, {
                recordingId,
                ownerUserId: userId,
                actorUserId,
                orgUserId,
            });
            if (refusal) throw new WriterRefused(refusal);
            if (args.jobId && !(await jobStillRunning(tx, args.jobId))) {
                throw new WriterRefused("cancelled");
            }

            const [current] = await tx
                .select({
                    id: transcriptions.id,
                    text: transcriptions.text,
                    turns: transcriptions.turns,
                    source: transcriptions.source,
                    model: transcriptions.model,
                })
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
                        topicsInputFingerprint: null,
                        detectedLanguage,
                        transcriptionType,
                        provider,
                        model,
                        source,
                        producedByUserId,
                        revision: sql`${transcriptions.revision} + 1`,
                    })
                    .where(
                        and(
                            eq(transcriptions.id, current.id),
                            eq(transcriptions.userId, userId),
                        ),
                    );
                // What was said about the text just replaced.
                await transcriptRewrittenInTx(tx, {
                    userId,
                    transcriptionId: current.id,
                    previous: storedSpeakerVersion(current),
                    next: speakerVersionOf({ source, model, text, turns }),
                    audioMd5: args.audioMd5,
                });
                if (args.dropSummaryOnReplace) {
                    await tx
                        .delete(aiEnhancements)
                        .where(
                            and(
                                eq(aiEnhancements.itemId, recordingId),
                                eq(aiEnhancements.userId, userId),
                                eq(
                                    aiEnhancements.source,
                                    args.dropSummaryOnReplace,
                                ),
                            ),
                        );
                }
            } else {
                await tx.insert(transcriptions).values({
                    recordingId,
                    userId,
                    text: encryptedText,
                    turns: encryptedTurns,
                    topics: null,
                    topicsInputFingerprint: null,
                    detectedLanguage,
                    transcriptionType,
                    provider,
                    model,
                    source,
                    producedByUserId,
                });
                // Which audio it was made from, for a later rewrite.
                await stampNewTranscriptAudioInTx(tx, {
                    recordingId,
                    userId,
                    source: source,
                    audioMd5: args.audioMd5,
                });
            }

            const now = new Date();
            await touchRecording(tx, recordingId, userId, now);
            await tx
                .update(chatterItems)
                .set({ updatedAt: now, contentReapedAt: null })
                .where(
                    and(
                        eq(chatterItems.id, recordingId),
                        eq(chatterItems.userId, userId),
                    ),
                );
        });
    } catch (txError) {
        if (txError === RECORDING_WRITE_BLOCKED) {
            return { committed: false };
        }
        if (txError instanceof WriterRefused) {
            return { committed: false, reason: txError.refusal };
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
    const actorUserId = args.actorUserId ?? userId;
    const producedByUserId = args.producedByUserId ?? actorUserId;
    // Before the transaction; see `sharingOrgUserId`.
    const orgUserId = await sharingOrgUserId();

    const isMail = args.kind === "mail";

    try {
        await db.transaction(async (tx) => {
            const [stillActive] = isMail
                ? await tx
                      .select({
                          deletedAt: chatterItems.deletedAt,
                          summaryReapedAt: chatterItems.summaryReapedAt,
                      })
                      .from(chatterItems)
                      .where(
                          and(
                              eq(chatterItems.id, recordingId),
                              eq(chatterItems.userId, userId),
                              eq(chatterItems.kind, "mail"),
                          ),
                      )
                      .for("update")
                      .limit(1)
                : await tx
                      .select({
                          deletedAt: recordings.deletedAt,
                          summaryReapedAt: chatterItems.summaryReapedAt,
                      })
                      .from(recordings)
                      .innerJoin(chatterItems, recordingItemJoin)
                      .where(
                          and(
                              eq(recordings.id, recordingId),
                              eq(recordings.userId, userId),
                          ),
                      )
                      .for("update")
                      .limit(1);

            if (
                !stillActive ||
                stillActive.deletedAt ||
                (stillActive.summaryReapedAt && !allowReaped)
            ) {
                throw RECORDING_WRITE_BLOCKED;
            }
            const refusal = await contentWriterRefusal(tx, {
                recordingId,
                ownerUserId: userId,
                actorUserId,
                orgUserId,
            });
            if (refusal) throw new WriterRefused(refusal);
            if (args.jobId && !(await jobStillRunning(tx, args.jobId))) {
                throw new WriterRefused("cancelled");
            }

            const [existing] = await tx
                .select({ id: aiEnhancements.id })
                .from(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.itemId, recordingId),
                        eq(aiEnhancements.userId, userId),
                        eq(aiEnhancements.source, source),
                    ),
                )
                .limit(1);

            // Always written, NULL included -- see `multiPass` on the args.
            const multiPassColumns = {
                inputFingerprint: args.inputFingerprint ?? null,
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
                    itemId: recordingId,
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
            if (args.tasks) {
                await writeTaskProposalsInTx(tx, {
                    recordingId,
                    ownerUserId: userId,
                    actorUserId,
                    proposals: args.tasks,
                });
            }

            const now = new Date();
            if (!isMail) await touchRecording(tx, recordingId, userId, now);
            await tx
                .update(chatterItems)
                .set({ updatedAt: now, summaryReapedAt: null })
                .where(
                    and(
                        eq(chatterItems.id, recordingId),
                        eq(chatterItems.userId, userId),
                    ),
                );
        });
    } catch (txError) {
        if (txError === RECORDING_WRITE_BLOCKED) {
            return { committed: false };
        }
        if (txError instanceof WriterRefused) {
            return { committed: false, reason: txError.refusal };
        }
        throw txError;
    }

    return { committed: true };
}
