/**
 * Running queued topic detection. The topics are written onto the
 * transcript row, encrypted, by `generateTopicsForTranscript`; the job's
 * result carries only counts and provenance, because the job row is not
 * encrypted.
 */

import type { JobHandler, JobResult } from "@/lib/jobs/types";
import { generateTopicsForTranscript } from "./generate-topics";
import {
    parseTopicsJobPayload,
    TOPICS_JOB_KIND,
    TOPICS_MAX_ATTEMPTS,
    TOPICS_TIMEOUT_MS,
    type TopicsJobPayload,
} from "./topics-job";

export const topicsJobHandler: JobHandler<TopicsJobPayload> = {
    kind: TOPICS_JOB_KIND,
    // One at a time, like summaries: both go to the same provider.
    concurrency: 1,
    maxAttempts: TOPICS_MAX_ATTEMPTS,
    timeoutMs: TOPICS_TIMEOUT_MS,
    backoff: { baseMs: 30_000, maxMs: 10 * 60_000, jitter: 0.3 },
    parsePayload: parseTopicsJobPayload,

    async run({ payload, userId, reportProgress }): Promise<JobResult> {
        const result = await generateTopicsForTranscript(
            userId,
            payload.recordingId,
            payload.source,
            {
                trigger: payload.trigger,
                onProgress: reportProgress,
            },
        );
        return {
            source: payload.source,
            topicCount: result.topics.length,
            provider: result.provider,
            model: result.model,
            templateId: result.templateId,
            windows: result.windows,
        };
    },
};
