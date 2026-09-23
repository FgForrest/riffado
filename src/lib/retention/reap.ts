import {
    claimRemoteOriginalReap,
    clearReapedMarkers,
    deleteSummaryForRecording,
    deleteTranscriptsForRecording,
    markKindsReaped,
    type ReapCandidate,
    type RetentionKind,
    type RetentionPolicy,
    releaseRemoteOriginalReapClaim,
} from "@/db/queries/retention";
import { movePlaudRecordingToTrash } from "@/lib/recordings/erase";
import type { StorageProvider } from "@/lib/storage/types";

export type { RetentionKind } from "@/db/queries/retention";

export interface ReapOutcome {
    /** Kinds whose data was removed on this pass. */
    reaped: RetentionKind[];
    /** Kind -> why it was skipped, for the worker's log line. */
    skipped: Partial<Record<RetentionKind, string>>;
    /** Kind -> operational error. Other independent kinds still run. */
    failed: Partial<Record<RetentionKind, unknown>>;
}

function isDue(startTime: Date, retentionDays: number | null, now: Date) {
    if (retentionDays === null) return false;
    return (
        startTime.getTime() <
        now.getTime() - retentionDays * 24 * 60 * 60 * 1000
    );
}

/**
 * Remove the kinds of data this policy selects from one aged recording.
 *
 * The recording row itself is never deleted. Retention takes payload --
 * the audio blob, the transcript rows, the summary row -- and leaves the
 * metadata (title, date, duration) in place, marked with what went and
 * when. That keeps the library legible after a sweep: a recording shows
 * up as "audio removed by retention" rather than vanishing or, worse,
 * turning into a broken player.
 *
 * Markdown sidecars are deliberately NOT touched. `<recording>.transcript.md`
 * is an *export* the user asked to have written into a folder they own,
 * not Riffado's copy of the data, and deleting files out of someone's
 * Documents folder is not a thing a retention setting should quietly do.
 * Removing the export is a manual act.
 */
export async function reapRecording(
    storage: StorageProvider,
    policy: RetentionPolicy,
    recording: ReapCandidate,
    now = new Date(),
): Promise<ReapOutcome> {
    const reaped: RetentionKind[] = [];
    const skipped: Partial<Record<RetentionKind, string>> = {};
    const failed: Partial<Record<RetentionKind, unknown>> = {};
    let audioPresent: boolean | undefined;

    const hasLocalAudio = async () => {
        if (audioPresent === undefined) {
            audioPresent = await storage.exists(recording.storagePath);
        }
        return audioPresent;
    };

    if (
        isDue(recording.startTime, policy.remoteOriginalDays, now) &&
        recording.deviceSn !== "local" &&
        !recording.isTrash
    ) {
        if (recording.downloadedAt === null) {
            skipped.remoteOriginal = "audio has not been downloaded locally";
        } else if (
            !(await claimRemoteOriginalReap(recording.id, policy.userId, now))
        ) {
            skipped.remoteOriginal = "claimed by another worker";
        } else {
            try {
                await movePlaudRecordingToTrash(policy.userId, recording.id);
                reaped.push("remoteOriginal");
            } catch (error) {
                failed.remoteOriginal = error;
            } finally {
                try {
                    await releaseRemoteOriginalReapClaim(
                        recording.id,
                        policy.userId,
                        now,
                    );
                } catch (error) {
                    failed.remoteOriginal ??= error;
                }
            }
        }
    }

    if (
        isDue(recording.startTime, policy.audioDays, now) &&
        recording.audioReapedAt === null &&
        // A shared recording's audio serves the whole Organization; see
        // `OrgRetentionContext`.
        recording.audioReleasable !== false
    ) {
        // `deleteFile` throws on a key that isn't there, and "already
        // gone" is a perfectly ordinary state here (a failed stamp on an
        // earlier tick, a manual cleanup). Check first so a missing blob
        // settles the marker instead of retrying forever, and a genuine
        // storage failure still surfaces as a failure.
        const present = await hasLocalAudio();
        if (present) {
            await storage.deleteFile(recording.storagePath);
        }
        reaped.push("audio");
    }

    if (
        isDue(recording.startTime, policy.transcriptDays, now) &&
        (policy.isOrg || recording.transcriptReapedAt === null)
    ) {
        const removed = await deleteTranscriptsForRecording(
            recording.id,
            policy.userId,
        );
        if (removed > 0) {
            reaped.push("transcript");
        } else {
            skipped.transcript = "no transcript to remove";
        }
    }

    if (
        isDue(recording.startTime, policy.summaryDays, now) &&
        (policy.isOrg || recording.summaryReapedAt === null)
    ) {
        const removed = await deleteSummaryForRecording(
            recording.id,
            policy.userId,
        );
        if (removed > 0) {
            reaped.push("summary");
        } else {
            skipped.summary = "no summary to remove";
        }
    }

    // The organization's reaping leaves no marker: markers describe the
    // owner's rows, which it never touches.
    const localKinds = reaped.filter((kind) => kind !== "remoteOriginal");
    if (!policy.isOrg) {
        await markKindsReaped(recording.id, policy.userId, localKinds, now);
    }

    return { reaped, skipped, failed };
}

/**
 * Drop the markers for kinds whose data is present again. Call this from
 * the paths that legitimately restore data -- a re-run transcription, a
 * regenerated summary, a re-downloaded blob -- so the sweep's bookkeeping
 * never outlives the condition it describes.
 */
export async function unmarkReaped(
    userId: string,
    recordingId: string,
    kinds: readonly RetentionKind[],
): Promise<void> {
    await clearReapedMarkers(recordingId, userId, kinds);
}
