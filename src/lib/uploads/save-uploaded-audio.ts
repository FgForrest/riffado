import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { captureServerEvent } from "@/lib/posthog-server";
import { buildRecordingStagingPath } from "@/lib/recordings/filename";
import { enqueueStorageReconciliationJob } from "@/lib/recordings/storage-reconciliation-job";
import type { StorageProvider } from "@/lib/storage/types";
import { autoTranscribeNewRecording } from "@/lib/transcription/auto-transcribe-new-recording";
import { readAudioDurationMs } from "@/lib/uploads/audio-duration";
import { getAudioMimeType } from "@/lib/utils";

export interface SaveUploadedAudioInput {
    userId: string;
    fileId: string;
    basename: string;
    extension: string;
    buffer: Buffer;
    storage: StorageProvider;
    sourceExtension: string;
    convertedFromVideo: boolean;
}

export interface SavedUploadedAudio {
    recordingId: string;
    filename: string;
    storageKey: string;
    durationMs: number;
    filesize: number;
}

export async function saveUploadedAudio(
    input: SaveUploadedAudioInput,
): Promise<SavedUploadedAudio> {
    const recordingId = nanoid();
    const storageKey = buildRecordingStagingPath(
        input.userId,
        recordingId,
        input.extension,
    );
    const contentType = getAudioMimeType(storageKey);
    const durationMs = await readAudioDurationMs(input.buffer, contentType);

    if (durationMs === 0) {
        throw new AppError(
            ErrorCode.INVALID_FILE_FORMAT,
            "File does not contain a valid audio stream",
            422,
        );
    }

    const md5 = createHash("md5").update(input.buffer).digest("hex");
    const now = new Date();

    await input.storage.uploadFile(storageKey, input.buffer, contentType);

    try {
        const [recording] = await db
            .insert(recordings)
            .values({
                id: recordingId,
                userId: input.userId,
                deviceSn: "local",
                plaudFileId: input.fileId,
                filename: encryptText(input.basename),
                duration: durationMs,
                startTime: now,
                endTime: new Date(now.getTime() + durationMs),
                filesize: input.buffer.length,
                fileMd5: md5,
                storageType: env.DEFAULT_STORAGE_TYPE,
                storagePath: storageKey,
                downloadedAt: now,
                plaudVersion: "1",
                isTrash: false,
            })
            .returning({ id: recordings.id });

        if (!recording) {
            throw new Error("Recording insert did not return a row");
        }
        if (recording.id !== recordingId) {
            throw new Error("Recording insert returned an unexpected id");
        }
    } catch (dbError) {
        try {
            await input.storage.deleteFile(storageKey);
        } catch (cleanupError) {
            console.error(
                "Failed to clean up orphaned audio after database insert error:",
                cleanupError,
            );
        }
        throw dbError;
    }

    await captureServerEvent({
        distinctId: input.userId,
        event: "recording_uploaded",
        properties: {
            duration_ms: durationMs,
            filesize_bytes: input.buffer.length,
            extension: input.extension,
            source_extension: input.sourceExtension,
            converted_from_video: input.convertedFromVideo,
        },
    });

    try {
        await enqueueStorageReconciliationJob({
            userId: input.userId,
            recordingId,
        });
    } catch (error) {
        console.error(
            `Could not queue storage filename reconciliation for recording ${recordingId}:`,
            error,
        );
    }

    try {
        await autoTranscribeNewRecording(input.userId, recordingId);
    } catch (error) {
        console.error(
            `Could not queue automatic transcription for recording ${recordingId}:`,
            error,
        );
    }

    return {
        recordingId,
        filename: input.basename,
        storageKey,
        durationMs,
        filesize: input.buffer.length,
    };
}
