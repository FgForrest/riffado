import {
    clearReapedMarkers,
    deleteSummaryForRecording,
    deleteTranscriptsForRecording,
    markKindsReaped,
    type ReapCandidate,
    type RetentionKind,
    type RetentionPolicy,
} from "@/db/queries/retention";
import type { StorageProvider } from "@/lib/storage/types";

export type { RetentionKind } from "@/db/queries/retention";

export interface ReapOutcome {
    /** Kinds whose data was removed on this pass. */
    reaped: RetentionKind[];
    /** Kind -> why it was skipped, for the worker's log line. */
    skipped: Partial<Record<RetentionKind, string>>;
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

    if (policy.audio && recording.audioReapedAt === null) {
        // `deleteFile` throws on a key that isn't there, and "already
        // gone" is a perfectly ordinary state here (a failed stamp on an
        // earlier tick, a manual cleanup). Check first so a missing blob
        // settles the marker instead of retrying forever, and a genuine
        // storage failure still surfaces as a failure.
        const present = await storage.exists(recording.storagePath);
        if (present) {
            await storage.deleteFile(recording.storagePath);
        }
        reaped.push("audio");
    }

    if (policy.transcript && recording.transcriptReapedAt === null) {
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

    if (policy.summary && recording.summaryReapedAt === null) {
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

    await markKindsReaped(recording.id, reaped, now);

    return { reaped, skipped };
}

/**
 * Drop the markers for kinds whose data is present again. Call this from
 * the paths that legitimately restore data -- a re-run transcription, a
 * regenerated summary, a re-downloaded blob -- so the sweep's bookkeeping
 * never outlives the condition it describes.
 */
export async function unmarkReaped(
    recordingId: string,
    kinds: readonly RetentionKind[],
): Promise<void> {
    await clearReapedMarkers(recordingId, kinds);
}
