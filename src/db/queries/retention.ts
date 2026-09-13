import { and, eq, exists, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";

/** One kind of data a retention policy can remove. */
export type RetentionKind = "audio" | "transcript" | "summary";

export interface RetentionPolicy {
    userId: string;
    retentionDays: number;
    audio: boolean;
    transcript: boolean;
    summary: boolean;
}

export interface ReapCandidate {
    id: string;
    storagePath: string;
    audioReapedAt: Date | null;
    transcriptReapedAt: Date | null;
    summaryReapedAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `now - retentionDays`. Recordings that started before this are due. */
export function retentionCutoff(retentionDays: number, now = Date.now()): Date {
    return new Date(now - retentionDays * DAY_MS);
}

/**
 * Every user whose retention policy is actually armed: the toggle is on,
 * a period is set, and at least one kind of data is selected for removal.
 *
 * The last condition is what makes the sweep safe to ship on top of a
 * column that has existed (doing nothing) since the first release --
 * `auto_delete_recordings = true` on its own selects nothing and deletes
 * nothing, so upgrading can't start destroying data behind anyone's back.
 */
export async function listArmedRetentionPolicies(
    limit: number,
): Promise<RetentionPolicy[]> {
    const rows = await db
        .select({
            userId: userSettings.userId,
            retentionDays: userSettings.retentionDays,
            audio: userSettings.retentionDeleteAudio,
            transcript: userSettings.retentionDeleteTranscript,
            summary: userSettings.retentionDeleteSummary,
        })
        .from(userSettings)
        .where(
            and(
                eq(userSettings.autoDeleteRecordings, true),
                sql`${userSettings.retentionDays} is not null`,
                sql`${userSettings.retentionDays} > 0`,
                or(
                    eq(userSettings.retentionDeleteAudio, true),
                    eq(userSettings.retentionDeleteTranscript, true),
                    eq(userSettings.retentionDeleteSummary, true),
                ),
            ),
        )
        .limit(limit);

    return rows.flatMap((row) =>
        row.retentionDays === null
            ? []
            : [{ ...row, retentionDays: row.retentionDays }],
    );
}

/**
 * Recordings older than `cutoff` that still hold at least one of the kinds
 * this policy removes.
 *
 * Each kind contributes its own "still there" test, and a recording only
 * qualifies if at least one of them passes -- so a sweep that has already
 * reaped everything it is allowed to reap returns nothing and the worker
 * goes quiet, instead of rediscovering the same rows every tick.
 *
 * Transcript and summary additionally require the row to actually exist.
 * Stamping a marker on a recording that never had a transcript would be a
 * lie, and worse, it would permanently suppress auto-transcribe for it.
 */
export async function listReapCandidates(
    policy: RetentionPolicy,
    cutoff: Date,
    limit: number,
): Promise<ReapCandidate[]> {
    const stillHasSomething = [];

    if (policy.audio) {
        stillHasSomething.push(isNull(recordings.audioReapedAt));
    }
    if (policy.transcript) {
        stillHasSomething.push(
            and(
                isNull(recordings.transcriptReapedAt),
                exists(
                    db
                        .select({ id: transcriptions.id })
                        .from(transcriptions)
                        .where(
                            and(
                                eq(transcriptions.recordingId, recordings.id),
                                eq(transcriptions.userId, policy.userId),
                            ),
                        ),
                ),
            ),
        );
    }
    if (policy.summary) {
        stillHasSomething.push(
            and(
                isNull(recordings.summaryReapedAt),
                exists(
                    db
                        .select({ id: aiEnhancements.id })
                        .from(aiEnhancements)
                        .where(
                            and(
                                eq(aiEnhancements.recordingId, recordings.id),
                                eq(aiEnhancements.userId, policy.userId),
                            ),
                        ),
                ),
            ),
        );
    }

    if (stillHasSomething.length === 0) return [];

    return db
        .select({
            id: recordings.id,
            storagePath: recordings.storagePath,
            audioReapedAt: recordings.audioReapedAt,
            transcriptReapedAt: recordings.transcriptReapedAt,
            summaryReapedAt: recordings.summaryReapedAt,
        })
        .from(recordings)
        .where(
            and(
                eq(recordings.userId, policy.userId),
                isNull(recordings.deletedAt),
                lt(recordings.startTime, cutoff),
                or(...stillHasSomething),
            ),
        )
        .orderBy(recordings.startTime)
        .limit(limit);
}

/** Delete this user's transcripts for a recording. Returns how many went. */
export async function deleteTranscriptsForRecording(
    recordingId: string,
    userId: string,
): Promise<number> {
    const rows = await db
        .delete(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
            ),
        )
        .returning({ id: transcriptions.id });
    return rows.length;
}

/** Delete this user's summary for a recording. Returns how many went. */
export async function deleteSummaryForRecording(
    recordingId: string,
    userId: string,
): Promise<number> {
    const rows = await db
        .delete(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.recordingId, recordingId),
                eq(aiEnhancements.userId, userId),
            ),
        )
        .returning({ id: aiEnhancements.id });
    return rows.length;
}

/**
 * Stamp the reaped-at markers for the kinds that were actually removed.
 * `updatedAt` moves too, so the incremental `/api/v1/recordings` feed
 * reports the change rather than silently serving a stale shape.
 */
export async function markKindsReaped(
    recordingId: string,
    kinds: readonly RetentionKind[],
    at: Date,
): Promise<void> {
    if (kinds.length === 0) return;

    await db
        .update(recordings)
        .set({
            ...(kinds.includes("audio") ? { audioReapedAt: at } : {}),
            ...(kinds.includes("transcript") ? { transcriptReapedAt: at } : {}),
            ...(kinds.includes("summary") ? { summaryReapedAt: at } : {}),
            updatedAt: at,
        })
        .where(eq(recordings.id, recordingId));
}

/**
 * Clear markers for data that has legitimately come back -- a re-run
 * transcription, a regenerated summary, a Plaud version bump that
 * re-downloads the audio. Leaving a stale marker set would make the UI
 * claim the data is gone while it is sitting right there, and would keep
 * auto-transcribe skipping a recording that now wants transcribing.
 */
export async function clearReapedMarkers(
    recordingId: string,
    kinds: readonly RetentionKind[],
): Promise<void> {
    if (kinds.length === 0) return;

    await db
        .update(recordings)
        .set({
            ...(kinds.includes("audio") ? { audioReapedAt: null } : {}),
            ...(kinds.includes("transcript")
                ? { transcriptReapedAt: null }
                : {}),
            ...(kinds.includes("summary") ? { summaryReapedAt: null } : {}),
        })
        .where(eq(recordings.id, recordingId));
}

/**
 * How many of a user's recordings the current policy would reap right
 * now. Shown in Settings before the first sweep runs, so enabling
 * retention is a decision made with the number in front of you rather
 * than a discovery made afterwards.
 */
export async function countReapCandidates(
    policy: RetentionPolicy,
    cutoff: Date,
): Promise<number> {
    const candidates = await listReapCandidates(policy, cutoff, 1000);
    return candidates.length;
}
