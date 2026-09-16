import { type EnqueueJobResult, enqueueJob } from "@/db/queries/async-jobs";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";

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
    force: boolean;
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
    if (raw.force !== undefined && typeof raw.force !== "boolean") {
        throw new InvalidJobPayloadError(
            TRANSCRIPTION_JOB_KIND,
            "force must be a boolean when present",
        );
    }
    return {
        recordingId: raw.recordingId,
        trigger: raw.trigger,
        providerId: raw.providerId,
        model: raw.model,
        force: raw.force ?? raw.trigger === "manual",
    };
}

/** Queue transcription, or return the active job for this recording. */
export async function enqueueTranscriptionJob(input: {
    userId: string;
    recordingId: string;
    trigger: "manual" | "sync" | "upload";
    providerId?: string;
    model?: string;
    force?: boolean;
}): Promise<EnqueueJobResult> {
    const enqueued = await enqueueJob({
        userId: input.userId,
        kind: TRANSCRIPTION_JOB_KIND,
        subjectId: input.recordingId,
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
            force: input.force ?? input.trigger === "manual",
        },
    });
    if (enqueued.created) nudge();
    return enqueued;
}
