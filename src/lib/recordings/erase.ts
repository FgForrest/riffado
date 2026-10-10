import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin, touchRecording } from "@/db/items";
import {
    aiEnhancements,
    asyncJobs,
    chatterItems,
    plaudConnections,
    recordings,
    transcriptions,
} from "@/db/schema";
import { sniffAudio } from "@/lib/audio/sniff";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    lockOrgTree,
    orgTreeChanged,
    withdrawRecordingInTx,
} from "@/lib/folders/folders";
import {
    knowledgeOnRecordingInTx,
    pruneUnsupportedFactsInTx,
} from "@/lib/knowledge/fact-evidence";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { createPlaudClient } from "@/lib/plaud/client-factory";
import { sidecarKey } from "@/lib/recordings/storage-files";
import { isRecordingShared } from "@/lib/sharing/shared";
import { recordingJobSubject } from "@/lib/sharing/view";
import {
    contentWriterRefusal,
    contentWriterRefusalNow,
    recordingShared,
    sharingOrgUserId,
    writerRefusalError,
} from "@/lib/sharing/writer";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { StorageProvider } from "@/lib/storage/types";
import { dropTasksWithoutSummaryInTx } from "@/lib/tasks/store";

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

/**
 * Erase one kind of a recording's local data.
 *
 * A shared recording is the organization account's to change, so its
 * owner's erase takes it out of the Organization first: refused (409)
 * unless `withdraw` says the owner agreed to that, and then withdrawn and
 * erased in one transaction, so the Organization never sees it half
 * erased.
 */
export async function eraseLocalArtifact(
    userId: string,
    recordingId: string,
    scope: LocalEraseScope,
    options: { withdraw?: boolean } = {},
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

    // Before the transaction, which would otherwise hold a second pooled
    // connection while it looks the account up.
    const orgUserId = await sharingOrgUserId();
    let withdrew = false;
    await db.transaction(async (tx) => {
        const now = new Date();
        // The knowledge scopes the withdrawal and the erasure reach, moved
        // once at the end.
        const scopes = new Set<string>();
        // Before the recording lock, as withdrawing takes them.
        if (orgUserId && options.withdraw) await lockOrgTree(tx);
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
        if (
            orgUserId &&
            (await isRecordingShared(recordingId, orgUserId, tx))
        ) {
            if (!options.withdraw) throw recordingShared();
            for (const scope of await withdrawRecordingInTx(
                tx,
                orgUserId,
                recordingId,
            )) {
                scopes.add(scope);
            }
            withdrew = true;
        }

        if (scope === "audio") {
            await cancelArtifactJobs(
                tx,
                userId,
                recordingId,
                ["transcription"],
                now,
            );
            // Without audio the Organization view cannot be transcribed
            // either; its queued run would only fail after being claimed.
            await tx
                .update(asyncJobs)
                .set({
                    status: "failed",
                    completedAt: now,
                    updatedAt: now,
                    heartbeatAt: null,
                    claimToken: null,
                    errorCode: ErrorCode.RECORDING_DATA_REAPED,
                    lastError:
                        "Cancelled because the recording audio was erased",
                })
                .where(
                    and(
                        eq(
                            asyncJobs.subjectId,
                            recordingJobSubject(recordingId, "org"),
                        ),
                        eq(asyncJobs.kind, "transcription"),
                        inArray(asyncJobs.status, ["pending", "processing"]),
                    ),
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
                [
                    "transcription",
                    "summary",
                    "topics",
                    "learn.run",
                    "title.generate",
                    "learn.release",
                    "learn.correct",
                ],
                now,
            );
            // A Learn run or correction pass on the Organization view
            // reads the same transcript, whoever started it.
            await tx
                .update(asyncJobs)
                .set({
                    status: "failed",
                    completedAt: now,
                    updatedAt: now,
                    heartbeatAt: null,
                    claimToken: null,
                    errorCode: ErrorCode.RECORDING_DATA_REAPED,
                    lastError:
                        "Cancelled because the recording artifact was erased",
                })
                .where(
                    and(
                        eq(
                            asyncJobs.subjectId,
                            recordingJobSubject(recordingId, "org"),
                        ),
                        inArray(asyncJobs.kind, ["learn.run", "learn.correct"]),
                        inArray(asyncJobs.status, ["pending", "processing"]),
                    ),
                );
            // Facts said only here go with the transcript.
            const knowledge = await knowledgeOnRecordingInTx(tx, recordingId);
            await tx
                .delete(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, recordingId),
                        eq(transcriptions.userId, userId),
                    ),
                );
            await pruneUnsupportedFactsInTx(tx, knowledge.factIds);
            await touchRecording(tx, recordingId, userId, now);
            await tx
                .update(chatterItems)
                // No transcript left for what waited for Learn.
                .set({
                    contentReapedAt: now,
                    updatedAt: now,
                    summaryDueAt: null,
                })
                .where(
                    and(
                        eq(chatterItems.id, recordingId),
                        eq(chatterItems.userId, userId),
                    ),
                );
            for (const scope of knowledge.scopes) scopes.add(scope);
        } else {
            await cancelArtifactJobs(tx, userId, recordingId, ["summary"], now);
            await tx
                .delete(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.itemId, recordingId),
                        eq(aiEnhancements.userId, userId),
                    ),
                );
            await dropTasksWithoutSummaryInTx(tx, {
                recordingId,
                ownerUserId: userId,
            });
            await touchRecording(tx, recordingId, userId, now);
            await tx
                .update(chatterItems)
                .set({ summaryReapedAt: now, updatedAt: now })
                .where(
                    and(
                        eq(chatterItems.id, recordingId),
                        eq(chatterItems.userId, userId),
                    ),
                );
        }
        await bumpScopeInTx(tx, scopes);
    });

    if (withdrew) await orgTreeChanged();

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
            ? chatterItems.contentReapedAt
            : chatterItems.summaryReapedAt;
    const [recording] = await db
        .select({ marker, deletedAt: recordings.deletedAt })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
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
    // Shared, the recording is the organization account's to change.
    const refusal = await contentWriterRefusalNow({
        recordingId,
        ownerUserId: userId,
        actorUserId: userId,
    });
    if (refusal) throw writerRefusalError(refusal);
    const client = await createPlaudClient(
        connection.bearerToken,
        connection.apiBase,
        connection.workspaceId,
    );
    const audio = await client.downloadRecording(recording.plaudFileId, false);
    const sniffed = sniffAudio(audio);
    const storage = await createUserStorageProvider(userId);
    const orgUserId = await sharingOrgUserId();
    // Written under the recording lock, once it is known to be still the
    // owner's to change: a share landing during the download must not have
    // its audio replaced, nor its retention marker cleared.
    await db.transaction(async (tx) => {
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
        const shared = await contentWriterRefusal(tx, {
            recordingId,
            ownerUserId: userId,
            actorUserId: userId,
            orgUserId,
        });
        if (shared) throw writerRefusalError(shared);
        await storage.uploadFile(
            recording.storagePath,
            audio,
            sniffed.contentType,
        );
        await tx
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
                ),
            );
    });
}
