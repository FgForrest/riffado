import {
    and,
    eq,
    exists,
    isNotNull,
    isNull,
    lt,
    ne,
    or,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";

/** One kind of data a retention policy can remove. */
export type RetentionKind =
    | "remoteOriginal"
    | "audio"
    | "transcript"
    | "summary";

export interface RetentionPolicy {
    userId: string;
    remoteOriginalDays: number | null;
    audioDays: number | null;
    transcriptDays: number | null;
    summaryDays: number | null;
}

export interface ReapCandidate {
    id: string;
    storagePath: string;
    startTime: Date;
    deviceSn: string;
    downloadedAt: Date | null;
    isTrash: boolean;
    audioReapedAt: Date | null;
    transcriptReapedAt: Date | null;
    summaryReapedAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `now - retentionDays`. Recordings that started before this are due. */
export function retentionCutoff(retentionDays: number, now = Date.now()): Date {
    return new Date(now - retentionDays * DAY_MS);
}

function validRetentionDays(value: number | null): number | null {
    return Number.isInteger(value) &&
        value !== null &&
        value >= 1 &&
        value <= 365
        ? value
        : null;
}

function effectivePolicy(row: {
    userId: string;
    retentionRemoteOriginalDays: number | null;
    retentionLocalAudioDays: number | null;
    retentionLocalTranscriptDays: number | null;
    retentionLocalSummaryDays: number | null;
    autoDeleteRecordings: boolean;
    retentionDays: number | null;
    retentionDeleteAudio: boolean;
    retentionDeleteTranscript: boolean;
    retentionDeleteSummary: boolean;
}): RetentionPolicy | null {
    const independent = [
        row.retentionRemoteOriginalDays,
        row.retentionLocalAudioDays,
        row.retentionLocalTranscriptDays,
        row.retentionLocalSummaryDays,
    ];
    const usesIndependentPolicy = independent.some((days) => days !== null);
    const legacyDays =
        row.autoDeleteRecordings && !usesIndependentPolicy
            ? validRetentionDays(row.retentionDays)
            : null;
    const policy: RetentionPolicy = {
        userId: row.userId,
        remoteOriginalDays: validRetentionDays(row.retentionRemoteOriginalDays),
        audioDays: usesIndependentPolicy
            ? validRetentionDays(row.retentionLocalAudioDays)
            : row.retentionDeleteAudio
              ? legacyDays
              : null,
        transcriptDays: usesIndependentPolicy
            ? validRetentionDays(row.retentionLocalTranscriptDays)
            : row.retentionDeleteTranscript
              ? legacyDays
              : null,
        summaryDays: usesIndependentPolicy
            ? validRetentionDays(row.retentionLocalSummaryDays)
            : row.retentionDeleteSummary
              ? legacyDays
              : null,
    };

    return Object.values(policy).some(
        (value) => typeof value === "number" && value > 0,
    )
        ? policy
        : null;
}

/**
 * Every user with at least one finite retention period. Legacy shared-period
 * settings remain effective until the first independent-policy write.
 */
export async function listArmedRetentionPolicies(
    limit: number,
): Promise<RetentionPolicy[]> {
    const rows = await db
        .select({
            userId: userSettings.userId,
            retentionRemoteOriginalDays:
                userSettings.retentionRemoteOriginalDays,
            retentionLocalAudioDays: userSettings.retentionLocalAudioDays,
            retentionLocalTranscriptDays:
                userSettings.retentionLocalTranscriptDays,
            retentionLocalSummaryDays: userSettings.retentionLocalSummaryDays,
            autoDeleteRecordings: userSettings.autoDeleteRecordings,
            retentionDays: userSettings.retentionDays,
            retentionDeleteAudio: userSettings.retentionDeleteAudio,
            retentionDeleteTranscript: userSettings.retentionDeleteTranscript,
            retentionDeleteSummary: userSettings.retentionDeleteSummary,
        })
        .from(userSettings)
        .where(
            or(
                sql`${userSettings.retentionRemoteOriginalDays} > 0`,
                sql`${userSettings.retentionLocalAudioDays} > 0`,
                sql`${userSettings.retentionLocalTranscriptDays} > 0`,
                sql`${userSettings.retentionLocalSummaryDays} > 0`,
                and(
                    eq(userSettings.autoDeleteRecordings, true),
                    sql`${userSettings.retentionDays} > 0`,
                    or(
                        eq(userSettings.retentionDeleteAudio, true),
                        eq(userSettings.retentionDeleteTranscript, true),
                        eq(userSettings.retentionDeleteSummary, true),
                    ),
                ),
            ),
        )
        .limit(limit);

    return rows.flatMap((row) => {
        const policy = effectivePolicy(row);
        return policy ? [policy] : [];
    });
}

/**
 * The predicate matching recordings older than `cutoff` that still hold
 * at least one of the kinds this policy removes. Shared by the sweep and
 * the Settings preview so the number the user is shown is produced by
 * the same condition that decides what actually gets deleted.
 *
 * Each kind contributes its own "still there" test, and a recording only
 * qualifies if at least one of them passes -- so a sweep that has already
 * reaped everything it is allowed to reap matches nothing and the worker
 * goes quiet, instead of rediscovering the same rows every tick.
 *
 * Transcript and summary additionally require the row to actually exist.
 * Stamping a marker on a recording that never had a transcript would be a
 * lie, and worse, it would permanently suppress auto-transcribe for it.
 *
 * Returns null when the policy selects nothing.
 */
function reapCandidateWhere(policy: RetentionPolicy, now: number) {
    const stillHasSomething = [];

    if (policy.remoteOriginalDays !== null) {
        stillHasSomething.push(
            and(
                lt(
                    recordings.startTime,
                    retentionCutoff(policy.remoteOriginalDays, now),
                ),
                ne(recordings.deviceSn, "local"),
                eq(recordings.isTrash, false),
                isNotNull(recordings.downloadedAt),
            ),
        );
    }
    if (policy.audioDays !== null) {
        stillHasSomething.push(
            and(
                lt(
                    recordings.startTime,
                    retentionCutoff(policy.audioDays, now),
                ),
                isNull(recordings.audioReapedAt),
            ),
        );
    }
    if (policy.transcriptDays !== null) {
        stillHasSomething.push(
            and(
                lt(
                    recordings.startTime,
                    retentionCutoff(policy.transcriptDays, now),
                ),
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
    if (policy.summaryDays !== null) {
        stillHasSomething.push(
            and(
                lt(
                    recordings.startTime,
                    retentionCutoff(policy.summaryDays, now),
                ),
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

    // Nothing selected: no predicate can be true, and callers treat null
    // as "this policy matches nothing" rather than building a query that
    // would scan the table to return no rows.
    if (stillHasSomething.length === 0) return null;

    return and(
        eq(recordings.userId, policy.userId),
        isNull(recordings.deletedAt),
        or(...stillHasSomething),
    );
}

export async function listReapCandidates(
    policy: RetentionPolicy,
    now: Date,
    limit: number,
): Promise<ReapCandidate[]> {
    const where = reapCandidateWhere(policy, now.getTime());
    if (where === null) return [];

    return db
        .select({
            id: recordings.id,
            storagePath: recordings.storagePath,
            startTime: recordings.startTime,
            deviceSn: recordings.deviceSn,
            downloadedAt: recordings.downloadedAt,
            isTrash: recordings.isTrash,
            audioReapedAt: recordings.audioReapedAt,
            transcriptReapedAt: recordings.transcriptReapedAt,
            summaryReapedAt: recordings.summaryReapedAt,
        })
        .from(recordings)
        .where(where)
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
    userId: string,
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
        .where(
            and(eq(recordings.id, recordingId), eq(recordings.userId, userId)),
        );
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
    userId: string,
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
        .where(
            and(eq(recordings.id, recordingId), eq(recordings.userId, userId)),
        );
}

const REMOTE_CLAIM_STALE_MS = 15 * 60 * 1000;

/** Claim one remote-original deletion across all application processes. */
export async function claimRemoteOriginalReap(
    recordingId: string,
    userId: string,
    now: Date,
): Promise<boolean> {
    const staleBefore = new Date(now.getTime() - REMOTE_CLAIM_STALE_MS);
    const rows = await db
        .update(recordings)
        .set({ remoteRetentionClaimedAt: now })
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
                eq(recordings.isTrash, false),
                or(
                    isNull(recordings.remoteRetentionClaimedAt),
                    lt(recordings.remoteRetentionClaimedAt, staleBefore),
                ),
            ),
        )
        .returning({ id: recordings.id });
    return rows.length > 0;
}

/** Release a remote-original retention claim after success or failure. */
export async function releaseRemoteOriginalReapClaim(
    recordingId: string,
    userId: string,
    claimedAt: Date,
): Promise<void> {
    await db
        .update(recordings)
        .set({ remoteRetentionClaimedAt: null })
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                eq(recordings.remoteRetentionClaimedAt, claimedAt),
            ),
        );
}

/**
 * How many of a user's recordings the current policy would reap right
 * now. Shown in Settings before the first sweep runs, so enabling
 * retention is a decision made with the number in front of you rather
 * than a discovery made afterwards.
 *
 * Counts in the database rather than fetching rows and measuring the
 * array: this is a hint next to a text input, so it must stay cheap
 * however large the library is.
 */
export async function countReapCandidates(
    policy: RetentionPolicy,
    now = Date.now(),
): Promise<number> {
    const where = reapCandidateWhere(policy, now);
    if (where === null) return 0;

    const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(recordings)
        .where(where);

    return row?.count ?? 0;
}
