import { AppError, ErrorCode } from "@/lib/errors";
import { isRetryableError } from "@/lib/jobs/retryable";
import type { JobHandler, JobResult } from "@/lib/jobs/types";
import { allowManualArtifactGeneration } from "@/lib/recordings/erase";
import {
    type TranscribeErrorCode,
    transcribeRecording,
} from "@/lib/transcription/transcribe-recording";
import {
    parseTranscriptionJobPayload,
    TRANSCRIPTION_JOB_KIND,
    TRANSCRIPTION_MAX_ATTEMPTS,
    TRANSCRIPTION_TIMEOUT_MS,
    type TranscriptionJobPayload,
} from "@/lib/transcription/transcription-job";

class CompletedTranscriptionFailure extends AppError {}

function failedResultError(
    code: TranscribeErrorCode | undefined,
): CompletedTranscriptionFailure {
    switch (code) {
        case "RECORDING_NOT_FOUND":
        case "RECORDING_DELETED":
            return new CompletedTranscriptionFailure(
                ErrorCode.RECORDING_NOT_FOUND,
                "Recording not found",
                404,
            );
        case "AUDIO_REAPED":
            return new CompletedTranscriptionFailure(
                ErrorCode.RECORDING_DATA_REAPED,
                "Audio was removed by the recording retention policy",
                410,
            );
        case "NO_TRANSCRIPTION_PROVIDER":
            return new CompletedTranscriptionFailure(
                ErrorCode.NO_TRANSCRIPTION_PROVIDER,
                "No transcription provider is configured",
                400,
            );
        case "HOSTED_LOCKED_OUT":
            return new CompletedTranscriptionFailure(
                ErrorCode.FORBIDDEN,
                "The hosted account cannot transcribe recordings",
                403,
            );
        case "MYNAH_BUDGET_EXHAUSTED":
            return new CompletedTranscriptionFailure(
                ErrorCode.MYNAH_BUDGET_EXHAUSTED,
                "The included Mynah transcription allowance is exhausted",
                402,
            );
        default:
            return new CompletedTranscriptionFailure(
                ErrorCode.TRANSCRIPTION_FAILED,
                "Automatic transcription failed",
                500,
            );
    }
}

export const transcriptionJobHandler: JobHandler<TranscriptionJobPayload> = {
    kind: TRANSCRIPTION_JOB_KIND,
    concurrency: 1,
    maxAttempts: TRANSCRIPTION_MAX_ATTEMPTS,
    timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
    parsePayload: parseTranscriptionJobPayload,
    isRetryable: (error) =>
        error instanceof CompletedTranscriptionFailure
            ? false
            : isRetryableError(error),

    async run({ payload, userId }): Promise<JobResult> {
        const allowed =
            payload.view === "org" ||
            (await allowManualArtifactGeneration(
                userId,
                payload.recordingId,
                "transcript",
                payload.trigger === "manual",
            ));
        if (!allowed) {
            throw new CompletedTranscriptionFailure(
                ErrorCode.RECORDING_DATA_REAPED,
                "Transcript was erased and can only be recreated manually",
                410,
            );
        }
        const result = await transcribeRecording(userId, payload.recordingId, {
            trigger: payload.trigger,
            providerId: payload.providerId,
            model: payload.model,
            attributionSource: payload.attributionSource,
            force: payload.force,
            view: payload.view,
        });
        if (!result.success) throw failedResultError(result.errorCode);
        return { transcribed: true };
    },
};
