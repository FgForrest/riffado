/**
 * Running a queued summary.
 *
 * The work itself still lives in `generateSummaryForRecording`; this is the
 * wrapper that makes it survive the process running it. That matters most for
 * the automatic path, which nobody is watching: before the queue, a container
 * upgrade partway through an auto-summary left a recording that simply never
 * got one, and no trace of why.
 *
 * Note what the handler returns. The summary itself is persisted by
 * `generateSummaryForRecording` through the encrypted `ai_enhancements`
 * route, exactly as it always was; the job's result carries only provenance,
 * because the job row is not encrypted. See the comment on `asyncJobs` in the
 * schema.
 *
 * Kept apart from `summary-job.ts` so that queueing a summary does not drag
 * an OpenAI client and the webhook emitter into the API route.
 */

import { AppError, ErrorCode } from "@/lib/errors";
import { describeJobError, isRetryableError } from "@/lib/jobs/retryable";
import type { JobHandler, JobResult } from "@/lib/jobs/types";
import { allowManualArtifactGeneration } from "@/lib/recordings/erase";
import { emitEvent } from "@/lib/webhooks/emit";
import { generateSummaryForRecording } from "./generate-summary";
import {
    parseSummaryJobPayload,
    SUMMARY_JOB_KIND,
    SUMMARY_MAX_ATTEMPTS,
    SUMMARY_TIMEOUT_MS,
    type SummaryJobPayload,
} from "./summary-job";

export const summaryJobHandler: JobHandler<SummaryJobPayload> = {
    kind: SUMMARY_JOB_KIND,
    // One at a time. A multi-pass job already fans out to N concurrent
    // provider calls, and against the agent bridge (`BRIDGE_MAX_CONCURRENCY`,
    // typically 3) a second concurrent job does not double throughput -- it
    // makes both jobs queue inside the bridge while appearing, from the
    // outside, to be two jobs that have stalled.
    concurrency: 1,
    maxAttempts: SUMMARY_MAX_ATTEMPTS,
    timeoutMs: SUMMARY_TIMEOUT_MS,
    // Longer than the generic default: the failures worth retrying here are a
    // provider rate limit or an outage, and neither clears in twenty seconds.
    backoff: { baseMs: 30_000, maxMs: 10 * 60_000, jitter: 0.3 },
    parsePayload: parseSummaryJobPayload,

    async run({
        payload,
        userId,
        attempt,
        maxAttempts,
        reportProgress,
    }): Promise<JobResult> {
        try {
            const allowed = await allowManualArtifactGeneration(
                userId,
                payload.recordingId,
                "summary",
                payload.trigger === "manual",
            );
            if (!allowed) {
                throw new AppError(
                    ErrorCode.RECORDING_DATA_REAPED,
                    "Summary was erased and can only be recreated manually",
                    410,
                );
            }
            const result = await generateSummaryForRecording(
                userId,
                payload.recordingId,
                {
                    presetId: payload.presetId,
                    trigger: payload.trigger,
                    onProgress: (progress) => reportProgress(progress),
                },
            );

            // Emitted here rather than in the transcription pipeline, so the
            // event still means "the summary is written and readable" now
            // that the write happens on a worker instead of inline.
            await emitEvent(
                "summary.completed",
                userId,
                payload.recordingId,
            ).catch(() => {});

            return {
                provider: result.provider,
                model: result.model,
                promptId: result.promptId,
                promptFallback: result.promptFallback,
                ...(result.multiPass ? { multiPass: result.multiPass } : {}),
            };
        } catch (error) {
            // Emit only when this failure is final. A `summary.failed` per
            // attempt would tell a subscriber the summary failed and then
            // have it succeed a minute later, which is worse for them than
            // hearing about it once, late.
            const willRetry = attempt < maxAttempts && isRetryableError(error);
            if (!willRetry) {
                const { message } = describeJobError(error);
                await emitEvent("summary.failed", userId, payload.recordingId, {
                    error: message,
                }).catch(() => {});
            }
            throw error;
        }
    },
};
