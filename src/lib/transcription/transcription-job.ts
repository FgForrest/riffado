import { type EnqueueJobResult, enqueueJob } from "@/db/queries/async-jobs";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";
import { type RecordingView, recordingJobSubject } from "@/lib/sharing/view";

export const TRANSCRIPTION_JOB_KIND = "transcription";
export const TRANSCRIPTION_PRIORITY_MANUAL = 10;
export const TRANSCRIPTION_PRIORITY_AUTO = 0;
export const TRANSCRIPTION_MAX_ATTEMPTS = 3;
export const TRANSCRIPTION_TIMEOUT_MS = 60 * 60 * 1000;

export interface TranscriptionJobPayload {
    recordingId: string;
    trigger: "manual" | "sync" | "upload";
    providerId?: string;
    model?: string;
    attributionSource?: "riffado" | "plaud" | "mixed";
    force: boolean;
    /** Absent on the private view, which is every job queued before views existed. */
    view?: RecordingView;
}

/** Validate a persisted transcription job payload. */
export function parseTranscriptionJobPayload(
    raw: Record<string, unknown>,
): TranscriptionJobPayload {
    if (typeof raw.recordingId !== "string" || raw.recordingId.length === 0) {
        throw new InvalidJobPayloadError(
            TRANSCRIPTION_JOB_KIND,
            "recordingId must be a non-empty string",
        );
    }
    if (
        raw.trigger !== "manual" &&
        raw.trigger !== "sync" &&
        raw.trigger !== "upload"
    ) {
        throw new InvalidJobPayloadError(
            TRANSCRIPTION_JOB_KIND,
            'trigger must be "manual", "sync", or "upload"',
        );
    }
    if (raw.providerId !== undefined && typeof raw.providerId !== "string") {
        throw new InvalidJobPayloadError(
            TRANSCRIPTION_JOB_KIND,
            "providerId must be a string when present",
        );
    }
    if (raw.model !== undefined && typeof raw.model !== "string") {
        throw new InvalidJobPayloadError(
            TRANSCRIPTION_JOB_KIND,
            "model must be a string when present",
        );
    }
    if (
        raw.attributionSource !== undefined &&
        raw.attributionSource !== "riffado" &&
        raw.attributionSource !== "plaud" &&
        raw.attributionSource !== "mixed"
    ) {
        throw new InvalidJobPayloadError(
            TRANSCRIPTION_JOB_KIND,
            'attributionSource must be "riffado", "plaud", or "mixed" when present',
        );
    }
    if (raw.force !== undefined && typeof raw.force !== "boolean") {
        throw new InvalidJobPayloadError(
            TRANSCRIPTION_JOB_KIND,
            "force must be a boolean when present",
        );
    }
    if (
        raw.view !== undefined &&
        raw.view !== "org" &&
        raw.view !== "private"
    ) {
        throw new InvalidJobPayloadError(
            TRANSCRIPTION_JOB_KIND,
            'view must be "private" or "org" when present',
        );
    }
    return {
        recordingId: raw.recordingId,
        trigger: raw.trigger,
        providerId: raw.providerId,
        model: raw.model,
        attributionSource: raw.attributionSource,
        force: raw.force ?? raw.trigger === "manual",
        ...(raw.view === "org" ? { view: "org" as const } : {}),
    };
}

/** Queue transcription, or return the active job for this recording. */
export async function enqueueTranscriptionJob(input: {
    userId: string;
    recordingId: string;
    trigger: "manual" | "sync" | "upload";
    providerId?: string;
    model?: string;
    attributionSource?: "riffado" | "plaud" | "mixed";
    force?: boolean;
    view?: RecordingView;
}): Promise<EnqueueJobResult> {
    const enqueued = await enqueueJob({
        userId: input.userId,
        kind: TRANSCRIPTION_JOB_KIND,
        subjectId: recordingJobSubject(
            input.recordingId,
            input.view ?? "private",
        ),
        priority:
            input.trigger === "manual"
                ? TRANSCRIPTION_PRIORITY_MANUAL
                : TRANSCRIPTION_PRIORITY_AUTO,
        maxAttempts: TRANSCRIPTION_MAX_ATTEMPTS,
        payload: {
            recordingId: input.recordingId,
            trigger: input.trigger,
            ...(input.providerId ? { providerId: input.providerId } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.attributionSource
                ? { attributionSource: input.attributionSource }
                : {}),
            force: input.force ?? input.trigger === "manual",
            ...(input.view === "org" ? { view: "org" } : {}),
        },
    });
    if (enqueued.created) nudge();
    return enqueued;
}
