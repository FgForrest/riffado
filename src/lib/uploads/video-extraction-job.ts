import { type EnqueueJobResult, enqueueJob } from "@/db/queries/async-jobs";
import { nudge } from "@/lib/jobs/nudge";
import {
    VIDEO_EXTRACTION_JOB_KIND,
    VIDEO_EXTRACTION_MAX_ATTEMPTS,
    type VideoExtractionJobPayload,
} from "./video-extraction-payload";

export {
    parseVideoExtractionJobPayload,
    VIDEO_EXTRACTION_JOB_KIND,
    VIDEO_EXTRACTION_MAX_ATTEMPTS,
    VIDEO_EXTRACTION_TIMEOUT_MS,
    type VideoExtractionJobPayload,
} from "./video-extraction-payload";

interface EnqueueVideoExtractionInput extends VideoExtractionJobPayload {
    userId: string;
}

export async function enqueueVideoExtractionJob(
    input: EnqueueVideoExtractionInput,
): Promise<EnqueueJobResult> {
    const enqueued = await enqueueJob({
        userId: input.userId,
        kind: VIDEO_EXTRACTION_JOB_KIND,
        subjectId: input.userId,
        maxAttempts: VIDEO_EXTRACTION_MAX_ATTEMPTS,
        payload: {
            uploadId: input.uploadId,
            sourceStorageKey: input.sourceStorageKey,
            encryptedFilename: input.encryptedFilename,
            sourceSize: input.sourceSize,
        },
    });
    if (enqueued.created) nudge();
    return enqueued;
}
