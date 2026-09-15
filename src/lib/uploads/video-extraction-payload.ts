import { InvalidJobPayloadError } from "@/lib/jobs/types";

export const VIDEO_EXTRACTION_JOB_KIND = "video-audio-extraction";
export const VIDEO_EXTRACTION_MAX_ATTEMPTS = 3;
export const VIDEO_EXTRACTION_TIMEOUT_MS = 60 * 60 * 1000;

export interface VideoExtractionJobPayload {
    uploadId: string;
    sourceStorageKey: string;
    encryptedFilename: string;
    sourceSize: number;
}

export function parseVideoExtractionJobPayload(
    raw: Record<string, unknown>,
): VideoExtractionJobPayload {
    const uploadId = raw.uploadId;
    const sourceStorageKey = raw.sourceStorageKey;
    const encryptedFilename = raw.encryptedFilename;
    const sourceSize = raw.sourceSize;

    if (typeof uploadId !== "string" || uploadId.length === 0) {
        throw new InvalidJobPayloadError(
            VIDEO_EXTRACTION_JOB_KIND,
            "uploadId must be a non-empty string",
        );
    }
    if (typeof sourceStorageKey !== "string" || sourceStorageKey.length === 0) {
        throw new InvalidJobPayloadError(
            VIDEO_EXTRACTION_JOB_KIND,
            "sourceStorageKey must be a non-empty string",
        );
    }
    if (
        typeof encryptedFilename !== "string" ||
        encryptedFilename.length === 0
    ) {
        throw new InvalidJobPayloadError(
            VIDEO_EXTRACTION_JOB_KIND,
            "encryptedFilename must be a non-empty string",
        );
    }
    if (
        typeof sourceSize !== "number" ||
        !Number.isSafeInteger(sourceSize) ||
        sourceSize < 0
    ) {
        throw new InvalidJobPayloadError(
            VIDEO_EXTRACTION_JOB_KIND,
            "sourceSize must be a non-negative integer",
        );
    }

    return { uploadId, sourceStorageKey, encryptedFilename, sourceSize };
}
