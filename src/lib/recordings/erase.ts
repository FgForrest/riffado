import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    asyncJobs,
    plaudConnections,
    recordings,
    transcriptions,
} from "@/db/schema";
import { sniffAudio } from "@/lib/audio/sniff";
import { AppError, ErrorCode } from "@/lib/errors";
import { createPlaudClient } from "@/lib/plaud/client-factory";
import { sidecarKey } from "@/lib/recordings/storage-files";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { StorageProvider } from "@/lib/storage/types";

export type LocalEraseScope = "audio" | "transcript" | "summary";
export type GeneratedArtifactKind = "transcript" | "summary";

const SIDECAR_SOURCES = [undefined, "plaud", "riffado", "mixed"] as const;

export function storageKeysForErase(
    audioPath: string,
    scope: LocalEraseScope | "all",
): string[] {
    if (scope === "audio") return [audioPath];
    if (scope === "transcript" || scope === "summary") {
        return SIDECAR_SOURCES.map((source) =>
            sidecarKey(audioPath, scope, source),
        );
    }
    return [
        ...storageKeysForErase(audioPath, "transcript"),
        ...storageKeysForErase(audioPath, "summary"),
        audioPath,
    ];
}

export function isStorageNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const candidate = error as {
        code?: unknown;
        name?: unknown;
        message?: unknown;
        $metadata?: { httpStatusCode?: unknown };
    };
    if (candidate.code === "ENOENT") return true;
    if (candidate.name === "NoSuchKey" || candidate.name === "NotFound") {
        return true;
    }
    if (candidate.$metadata?.httpStatusCode === 404) return true;
    return (
        typeof candidate.message === "string" &&
        /(ENOENT|NoSuchKey|NotFound|no such file or directory)/i.test(
            candidate.message,
        )
    );
}

export async function deleteRecordingStorageArtifacts(
    storage: StorageProvider,
    audioPath: string,
    scope: LocalEraseScope | "all",
): Promise<void> {
    for (const key of storageKeysForErase(audioPath, scope)) {
        try {
            await storage.deleteFile(key);
        } catch (error) {
            if (!isStorageNotFoundError(error)) throw error;
        }
    }
}

async function cancelArtifactJobs(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    userId: string,
    recordingId: string,
    kinds: string[],
    now: Date,
): Promise<void> {
    await tx
        .update(asyncJobs)
        .set({
            status: "failed",
            completedAt: now,
            updatedAt: now,
            heartbeatAt: null,
            claimToken: null,
            errorCode: ErrorCode.RECORDING_DATA_REAPED,
            lastError: "Cancelled because the recording artifact was erased",
        })
        .where(
            and(
                eq(asyncJobs.userId, userId),
                eq(asyncJobs.subjectId, recordingId),
                inArray(asyncJobs.kind, kinds),
                inArray(asyncJobs.status, ["pending", "processing"]),
            ),
        );
}

export async function eraseLocalArtifact(
    userId: string,
    recordingId: string,
    scope: LocalEraseScope,
): Promise<void> {
    const [recording] = await db
        .select({ storagePath: recordings.storagePath })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    await db.transaction(async (tx) => {
        const now = new Date();
        const [locked] = await tx
            .select({ deletedAt: recordings.deletedAt })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            )
            .for("update")
            .limit(1);
        if (!locked || locked.deletedAt) {
            throw new AppError(
                ErrorCode.RECORDING_NOT_FOUND,
                "Recording not found",
                404,
            );
        }

        if (scope === "audio") {
            await cancelArtifactJobs(
                tx,
                userId,
                recordingId,
                ["transcription"],
                now,
            );
            await tx
                .update(recordings)
                .set({
                    audioReapedAt: now,
                    waveformPeaks: null,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                    ),
                );
        } else if (scope === "transcript") {
            await cancelArtifactJobs(
                tx,
                userId,
                recordingId,
                ["transcription", "summary"],
                now,
            );
            await tx
                .delete(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, recordingId),
                        eq(transcriptions.userId, userId),
                    ),
                );
            await tx
                .update(recordings)
                .set({ transcriptReapedAt: now, updatedAt: now })
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                    ),
                );
        } else {
            await cancelArtifactJobs(tx, userId, recordingId, ["summary"], now);
            await tx
                .delete(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.recordingId, recordingId),
                        eq(aiEnhancements.userId, userId),
                    ),
                );
            await tx
                .update(recordings)
                .set({ summaryReapedAt: now, updatedAt: now })
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                    ),
                );
        }
    });

    try {
        const storage = await createUserStorageProvider(userId);
        await deleteRecordingStorageArtifacts(
            storage,
            recording.storagePath,
            scope,
        );
    } catch (error) {
        console.error(
            `Failed to delete ${scope} storage artifacts for recording ${recordingId}:`,
            error,
        );
        throw new AppError(
            ErrorCode.STORAGE_ERROR,
            `The ${scope} was erased from Riffado, but an exported file could not be removed. Retry to finish cleanup.`,
            500,
        );
    }
}

export async function allowManualArtifactGeneration(
    userId: string,
    recordingId: string,
    kind: GeneratedArtifactKind,
    manual: boolean,
): Promise<boolean> {
    const marker =
        kind === "transcript"
            ? recordings.transcriptReapedAt
            : recordings.summaryReapedAt;
    const [recording] = await db
        .select({ marker, deletedAt: recordings.deletedAt })
        .from(recordings)
        .where(
            and(eq(recordings.id, recordingId), eq(recordings.userId, userId)),
        )
        .limit(1);
    if (!recording || recording.deletedAt) return false;
    if (!recording.marker) return true;
    return manual;
}

async function loadRemoteRecording(userId: string, recordingId: string) {
    const [[recording], [connection]] = await Promise.all([
        db
            .select({
                id: recordings.id,
                plaudFileId: recordings.plaudFileId,
                deviceSn: recordings.deviceSn,
                storagePath: recordings.storagePath,
            })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1),
        db
            .select({
                bearerToken: plaudConnections.bearerToken,
                apiBase: plaudConnections.apiBase,
                workspaceId: plaudConnections.workspaceId,
            })
            .from(plaudConnections)
            .where(eq(plaudConnections.userId, userId))
            .limit(1),
    ]);
    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    if (recording.deviceSn === "local") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "This recording has no Plaud copy",
            400,
        );
    }
    if (!connection) {
        throw new AppError(
            ErrorCode.PLAUD_NOT_CONNECTED,
            "Connect Plaud before changing its remote copy",
            409,
        );
    }
    return { recording, connection };
}

export async function movePlaudRecordingToTrash(
    userId: string,
    recordingId: string,
): Promise<void> {
    const { recording, connection } = await loadRemoteRecording(
        userId,
        recordingId,
    );
    const client = await createPlaudClient(
        connection.bearerToken,
        connection.apiBase,
        connection.workspaceId,
    );
    const result = await client.moveFileToTrash(recording.plaudFileId);
    if (result.status !== 0) {
        throw new AppError(
            ErrorCode.PLAUD_API_ERROR,
            result.msg || "Plaud did not move the recording to Trash",
            400,
            { plaudStatus: result.status },
        );
    }
    await db
        .update(recordings)
        .set({ isTrash: true, updatedAt: new Date() })
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        );
}

export async function restoreAudioFromPlaud(
    userId: string,
    recordingId: string,
): Promise<void> {
    const { recording, connection } = await loadRemoteRecording(
        userId,
        recordingId,
    );
    const client = await createPlaudClient(
        connection.bearerToken,
        connection.apiBase,
        connection.workspaceId,
    );
    const audio = await client.downloadRecording(recording.plaudFileId, false);
    const sniffed = sniffAudio(audio);
    const storage = await createUserStorageProvider(userId);
    await storage.uploadFile(recording.storagePath, audio, sniffed.contentType);
    await db
        .update(recordings)
        .set({
            audioReapedAt: null,
            downloadedAt: new Date(),
            filesize: audio.length,
            waveformPeaks: null,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        );
}
