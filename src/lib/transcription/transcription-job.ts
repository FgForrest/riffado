import { type EnqueueJobResult, enqueueJob } from "@/db/queries/async-jobs";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";

export const TRANSCRIPTION_JOB_KIND = "transcription";
export const TRANSCRIPTION_MAX_ATTEMPTS = 3;
export const TRANSCRIPTION_TIMEOUT_MS = 60 * 60 * 1000;

export interface TranscriptionJobPayload {
    recordingId: string;
    trigger: "upload";
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
    if (raw.trigger !== "upload") {
        throw new InvalidJobPayloadError(
            TRANSCRIPTION_JOB_KIND,
            'trigger must be "upload"',
        );
    }
    return { recordingId: raw.recordingId, trigger: raw.trigger };
}

/** Queue automatic transcription for an uploaded recording. */
export async function enqueueTranscriptionJob(input: {
    userId: string;
    recordingId: string;
}): Promise<EnqueueJobResult> {
    const enqueued = await enqueueJob({
        userId: input.userId,
        kind: TRANSCRIPTION_JOB_KIND,
        subjectId: input.recordingId,
        maxAttempts: TRANSCRIPTION_MAX_ATTEMPTS,
        payload: {
            recordingId: input.recordingId,
            trigger: "upload",
        },
    });
    if (enqueued.created) nudge();
    return enqueued;
}
