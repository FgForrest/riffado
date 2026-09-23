import type { InferSelectModel } from "drizzle-orm";
import type { recordings } from "@/db/schema";
import type { RecordingView } from "@/lib/sharing/view";

export type RecordingQueryResult = Pick<
    InferSelectModel<typeof recordings>,
    "id" | "filename" | "duration" | "startTime" | "filesize" | "deviceSn"
>;

export type Recording = Omit<RecordingQueryResult, "startTime"> & {
    startTime: string;
    /**
     * Status flags surfaced into list rows so the user can scan which
     * recordings have already been processed. Both default to `false`
     * for backward compatibility with callers that don't compute them.
     */
    hasTranscript?: boolean;
    hasSummary?: boolean;
    /**
     * Coarse normalized amplitude peaks ([0, 1]) for waveform rendering.
     * Decoded client-side on first listen and cached server-side. Null
     * when never decoded; an empty array would be invalid (treat as null).
     */
    waveformPeaks?: number[] | null;
    /**
     * True when the retention sweep has deleted this recording's audio.
     * The row survives a sweep, so the UI has to distinguish "no audio
     * because it was deliberately removed" from "audio that should be
     * there" -- otherwise the player renders and then fails on play.
     */
    audioReaped?: boolean;
    /**
     * `org` marks an entry of the Organization library: a shared recording
     * read through its Organization view. Absent for the owner's own list.
     */
    view?: RecordingView;
    /** Whether the viewer owns the recording. Absent means yes. */
    isOwn?: boolean;
    /** Display name of the owner, on Organization entries. */
    ownerName?: string | null;
};

// Helper to serialize a recording query result. Optional fields let
// callers that don't compute flags (sync worker, v1 API) skip them.
export function serializeRecording(
    recording: RecordingQueryResult,
    flags?: {
        hasTranscript?: boolean;
        hasSummary?: boolean;
        waveformPeaks?: number[] | null;
        audioReaped?: boolean;
        view?: RecordingView;
        isOwn?: boolean;
        ownerName?: string | null;
    },
): Recording {
    return {
        ...recording,
        startTime: recording.startTime.toISOString(),
        hasTranscript: flags?.hasTranscript ?? false,
        hasSummary: flags?.hasSummary ?? false,
        audioReaped: flags?.audioReaped ?? false,
        // Empty arrays would be invalid per the field contract ("null
        // when never decoded"); collapse them to null at the
        // serialization boundary so consumers never have to special-case
        // `peaks.length === 0`.
        waveformPeaks: flags?.waveformPeaks?.length
            ? flags.waveformPeaks
            : null,
        ...(flags?.view === "org"
            ? {
                  view: "org" as const,
                  isOwn: flags.isOwn ?? false,
                  ownerName: flags.ownerName ?? null,
              }
            : {}),
    };
}
