import { createHash } from "node:crypto";
import { parseBuffer } from "music-metadata";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { captureServerEvent } from "@/lib/posthog-server";
import type { StorageProvider } from "@/lib/storage/types";
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
    filename: string;
    storageKey: string;
    durationMs: number;
    filesize: number;
}

async function getAudioDurationMs(
    buffer: Uint8Array,
    mimeType: string,
): Promise<number> {
    try {
        const { format } = await parseBuffer(
            buffer,
            { mimeType, size: buffer.byteLength },
            { duration: true },
        );
        const seconds = format.duration ?? 0;
        return seconds > 0 ? Math.round(seconds * 1000) : 0;
    } catch (error) {
        console.error("Audio metadata parse failed:", error);
        return 0;
    }
}

export async function saveUploadedAudio(
    input: SaveUploadedAudioInput,
): Promise<SavedUploadedAudio> {
    const storageKey = `${input.userId}/${input.fileId}${input.extension}`;
    const contentType = getAudioMimeType(storageKey);
    const durationMs = await getAudioDurationMs(input.buffer, contentType);

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
        await db.insert(recordings).values({
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
        });
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

    return {
        filename: input.basename,
        storageKey,
        durationMs,
        filesize: input.buffer.length,
    };
}
