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
import { recordingItemJoin, touchRecording } from "@/db/items";
import {
    aiEnhancements,
    chatterItems,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import {
    knowledgeOnRecordingInTx,
    pruneUnsupportedFactsInTx,
} from "@/lib/knowledge/fact-evidence";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { isRecordingShared } from "@/lib/sharing/shared";
import { dropTasksWithoutSummaryInTx } from "@/lib/tasks/store";

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
    /**
     * The organization account's policy. A shared recording is one
     * recording, the organization account's to change, so while it is
     * shared this policy governs its audio, transcripts and summaries --
     * its owner's rows -- and its owner's policy none of them. It never
     * touches a Plaud original, which is the owner's Plaud account. After a
     * withdrawal the owner's policy applies at once.
     */
    isOrg?: boolean;
}

export interface ReapCandidate {
    id: string;
    /** The recording's owner, whose rows and markers are reaped. */
    userId: string;
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

/** A stored period when it is one (1 to 365 days), else null. */
export function validRetentionDays(value: number | null): number | null {
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
            role: users.role,
        })
        .from(userSettings)
        .innerJoin(users, eq(users.id, userSettings.userId))
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
        // The organization account's policy first, as it alone governs
        // every shared recording; the rest in a different order each tick,
        // so no account waits behind the same `limit` others for good.
        .orderBy(sql`${users.role} = 'org' desc`, sql`random()`)
        .limit(limit);

    return rows.flatMap((row) => {
        const policy = effectivePolicy(row);
        if (!policy) return [];
        if (row.role !== "org") return [policy];
        // Plaud originals are their owners' Plaud accounts.
        const orgPolicy: RetentionPolicy = {
            ...policy,
            remoteOriginalDays: null,
            isOrg: true,
        };
        return orgPolicy.audioDays !== null ||
            orgPolicy.transcriptDays !== null ||
            orgPolicy.summaryDays !== null
            ? [orgPolicy]
            : [];
    });
}

/** One kind a withdrawal would hand to its owner's policy already past due. */
export interface DueOnWithdrawal {
    kind: Exclude<RetentionKind, "remoteOriginal">;
    days: number;
}

/**
 * What the owner's retention policy would remove from a shared recording
 * at its next sweep, were it withdrawn now: the kinds past the owner's
 * periods that are still there. The withdraw confirmation warns with it,
 * as nothing is kept past the owner's policy once the Organization lets
 * go of the recording.
 */
export async function dueOnWithdrawal(
    recordingId: string,
    ownerUserId: string,
    now = Date.now(),
): Promise<DueOnWithdrawal[]> {
    const [settings] = await db
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
        .where(eq(userSettings.userId, ownerUserId))
        .limit(1);
    const policy = settings ? effectivePolicy(settings) : null;
    if (!policy) return [];
    const [recording] = await db
        .select({
            startTime: chatterItems.occurredAt,
            audioReapedAt: recordings.audioReapedAt,
            transcriptReapedAt: chatterItems.contentReapedAt,
            summaryReapedAt: chatterItems.summaryReapedAt,
        })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, ownerUserId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) return [];
    const due = (days: number | null): days is number =>
        days !== null &&
        recording.startTime.getTime() < retentionCutoff(days, now).getTime();

    const found: DueOnWithdrawal[] = [];
    if (due(policy.audioDays) && recording.audioReapedAt === null) {
        found.push({ kind: "audio", days: policy.audioDays });
    }
    if (due(policy.transcriptDays) && recording.transcriptReapedAt === null) {
        const [row] = await db
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, ownerUserId),
                ),
            )
            .limit(1);
        if (row)
            found.push({ kind: "transcript", days: policy.transcriptDays });
    }
    if (due(policy.summaryDays) && recording.summaryReapedAt === null) {
        const [row] = await db
            .select({ id: aiEnhancements.id })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, recordingId),
                    eq(aiEnhancements.userId, ownerUserId),
                ),
            )
            .limit(1);
        if (row) found.push({ kind: "summary", days: policy.summaryDays });
    }
    return found;
}

function sharedWithOrgCondition(orgUserId: string) {
    return sql`exists (
        select 1
        from ${recordingFolderAssignments}
        inner join ${recordingFolders}
            on ${recordingFolders.id} = ${recordingFolderAssignments.folderId}
        where ${recordingFolderAssignments.itemId} = ${recordings.id}
            and ${recordingFolders.userId} = ${orgUserId}
    )`;
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
function reapCandidateWhere(
    policy: RetentionPolicy,
    now: number,
    orgUserId?: string | null,
) {
    // A shared recording's audio, transcripts and summaries are the
    // Organization's policy's, and only those: see `RetentionPolicy.isOrg`.
    const governed = policy.isOrg
        ? sharedWithOrgCondition(policy.userId)
        : orgUserId
          ? sql`not ${sharedWithOrgCondition(orgUserId)}`
          : undefined;
    const ungoverned = [];
    const governedKinds = [];

    if (policy.remoteOriginalDays !== null) {
        ungoverned.push(
            and(
                lt(
                    chatterItems.occurredAt,
                    retentionCutoff(policy.remoteOriginalDays, now),
                ),
                ne(recordings.deviceSn, "local"),
                eq(recordings.isTrash, false),
                isNotNull(recordings.downloadedAt),
            ),
        );
    }
    if (policy.audioDays !== null) {
        governedKinds.push(
            and(
                lt(
                    chatterItems.occurredAt,
                    retentionCutoff(policy.audioDays, now),
                ),
                isNull(recordings.audioReapedAt),
            ),
        );
    }
    if (policy.transcriptDays !== null) {
        governedKinds.push(
            and(
                lt(
                    chatterItems.occurredAt,
                    retentionCutoff(policy.transcriptDays, now),
                ),
                isNull(chatterItems.contentReapedAt),
                exists(
                    db
                        .select({ id: transcriptions.id })
                        .from(transcriptions)
                        .where(
                            and(
                                eq(transcriptions.recordingId, recordings.id),
                                eq(transcriptions.userId, recordings.userId),
                            ),
                        ),
                ),
            ),
        );
    }
    if (policy.summaryDays !== null) {
        governedKinds.push(
            and(
                lt(
                    chatterItems.occurredAt,
                    retentionCutoff(policy.summaryDays, now),
                ),
                isNull(chatterItems.summaryReapedAt),
                or(
                    exists(
                        db
                            .select({ id: aiEnhancements.id })
                            .from(aiEnhancements)
                            .where(
                                and(
                                    eq(aiEnhancements.itemId, recordings.id),
                                    eq(
                                        aiEnhancements.userId,
                                        recordings.userId,
                                    ),
                                ),
                            ),
                    ),
                    // Tasks left by a summary a re-run replaced and nothing
                    // made again: they age with the summaries.
                    exists(
                        db
                            .select({ id: recordingTasks.id })
                            .from(recordingTasks)
                            .where(eq(recordingTasks.itemId, recordings.id)),
                    ),
                ),
            ),
        );
    }

    // Nothing selected: no predicate can be true, and callers treat null
    // as "this policy matches nothing" rather than building a query that
    // would scan the table to return no rows.
    const periods = [
        policy.remoteOriginalDays,
        policy.audioDays,
        policy.transcriptDays,
        policy.summaryDays,
    ].filter((days): days is number => days !== null);
    if (periods.length === 0) return null;

    // The Organization's recordings are other people's; they are selected
    // by being shared, above.
    return and(
        policy.isOrg ? undefined : eq(recordings.userId, policy.userId),
        isNull(recordings.deletedAt),
        lt(chatterItems.occurredAt, retentionCutoff(Math.min(...periods), now)),
        or(
            ...ungoverned,
            governedKinds.length > 0
                ? and(governed, or(...governedKinds))
                : undefined,
        ),
    );
}

/**
 * `orgUserId`: the organization account an owner's policy yields shared
 * recordings to, or null when this instance shows no Organization.
 */
export async function listReapCandidates(
    policy: RetentionPolicy,
    now: Date,
    limit: number,
    orgUserId?: string | null,
): Promise<ReapCandidate[]> {
    const where = reapCandidateWhere(policy, now.getTime(), orgUserId);
    if (where === null) return [];

    return db
        .select({
            id: recordings.id,
            userId: recordings.userId,
            storagePath: recordings.storagePath,
            startTime: chatterItems.occurredAt,
            deviceSn: recordings.deviceSn,
            downloadedAt: recordings.downloadedAt,
            isTrash: recordings.isTrash,
            audioReapedAt: recordings.audioReapedAt,
            transcriptReapedAt: chatterItems.contentReapedAt,
            summaryReapedAt: chatterItems.summaryReapedAt,
        })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(where)
        .orderBy(chatterItems.occurredAt)
        .limit(limit);
}

/**
 * Which policy may reap a recording: the owner's while it is not shared,
 * the organization account's while it is (`RetentionPolicy.isOrg`).
 * `orgUserId` is that account, or null when this instance shows none.
 */
export interface RetentionGovernor {
    isOrg: boolean;
    orgUserId: string | null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lock the recording, as sharing and withdrawing do, and say whether the
 * governor still governs it: a share or a withdrawal that landed after the
 * sweep chose it wins, and the policy that chose it leaves it alone.
 */
async function lockGovernedInTx(
    tx: Tx,
    recordingId: string,
    governor: RetentionGovernor,
): Promise<boolean> {
    await tx
        .select({ id: recordings.id })
        .from(recordings)
        .where(eq(recordings.id, recordingId))
        .for("update");
    if (!governor.orgUserId) return !governor.isOrg;
    const shared = await isRecordingShared(recordingId, governor.orgUserId, tx);
    return shared === governor.isOrg;
}

/**
 * Delete a recording's audio file with `removeFile`, and mark it reaped, if
 * the governor still governs the recording: under its lock, which sharing
 * and withdrawing wait for, so neither lands between the check and the
 * deletion. Returns whether the audio was reaped.
 */
export async function reapAudioForRecording(
    recordingId: string,
    ownerUserId: string,
    governor: RetentionGovernor,
    at: Date,
    removeFile: () => Promise<void>,
): Promise<boolean> {
    return db.transaction(async (tx) => {
        if (!(await lockGovernedInTx(tx, recordingId, governor))) return false;
        await removeFile();
        await tx
            .update(recordings)
            .set({ audioReapedAt: at, updatedAt: at })
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, ownerUserId),
                ),
            );
        return true;
    });
}

/**
 * Delete a recording's transcripts, which its owner holds, and mark them
 * reaped, if the governor still governs it: one transaction, so nothing
 * regenerated meanwhile is marked as gone. Returns how many went.
 */
export async function deleteTranscriptsForRecording(
    recordingId: string,
    ownerUserId: string,
    governor: RetentionGovernor,
    at: Date,
): Promise<number> {
    return db.transaction(async (tx) => {
        if (!(await lockGovernedInTx(tx, recordingId, governor))) return 0;
        // Facts said only here decay with the transcript.
        const knowledge = await knowledgeOnRecordingInTx(tx, recordingId);
        const rows = await tx
            .delete(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, ownerUserId),
                ),
            )
            .returning({ id: transcriptions.id });
        await pruneUnsupportedFactsInTx(tx, knowledge.factIds);
        // Stamping a recording that had no transcript would be a lie, and
        // would suppress auto-transcription of it for good.
        if (rows.length > 0) {
            await markItemReapedInTx(tx, recordingId, ownerUserId, {
                contentReapedAt: at,
            });
            await touchRecording(tx, recordingId, ownerUserId, at);
        }
        await bumpScopeInTx(tx, knowledge.scopes);
        return rows.length;
    });
}

/**
 * Delete a recording's summaries, which its owner holds, and mark them
 * reaped, if the governor still governs it. Returns how many went.
 */
export async function deleteSummaryForRecording(
    recordingId: string,
    ownerUserId: string,
    governor: RetentionGovernor,
    at: Date,
): Promise<number> {
    return db.transaction(async (tx) => {
        if (!(await lockGovernedInTx(tx, recordingId, governor))) return 0;
        const rows = await tx
            .delete(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, recordingId),
                    eq(aiEnhancements.userId, ownerUserId),
                ),
            )
            .returning({ id: aiEnhancements.id });
        await dropTasksWithoutSummaryInTx(tx, { recordingId, ownerUserId });
        if (rows.length > 0) {
            await markItemReapedInTx(tx, recordingId, ownerUserId, {
                summaryReapedAt: at,
            });
            await touchRecording(tx, recordingId, ownerUserId, at);
        }
        return rows.length;
    });
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

    if (kinds.includes("audio")) {
        await db
            .update(recordings)
            .set({ audioReapedAt: null })
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            );
    }
    if (kinds.includes("transcript") || kinds.includes("summary")) {
        await db
            .update(chatterItems)
            .set({
                ...(kinds.includes("transcript")
                    ? { contentReapedAt: null }
                    : {}),
                ...(kinds.includes("summary") ? { summaryReapedAt: null } : {}),
            })
            .where(
                and(
                    eq(chatterItems.id, recordingId),
                    eq(chatterItems.userId, userId),
                ),
            );
    }
}

async function markItemReapedInTx(
    tx: Tx,
    itemId: string,
    ownerUserId: string,
    markers: { contentReapedAt?: Date; summaryReapedAt?: Date },
): Promise<void> {
    const at = markers.contentReapedAt ?? markers.summaryReapedAt;
    await tx
        .update(chatterItems)
        .set({ ...markers, updatedAt: at })
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, ownerUserId),
            ),
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
    orgUserId?: string | null,
): Promise<number> {
    const where = reapCandidateWhere(policy, now, orgUserId);
    if (where === null) return 0;

    const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(where);

    return row?.count ?? 0;
}
