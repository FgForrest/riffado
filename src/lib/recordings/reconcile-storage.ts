import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import {
    audioExtension,
    buildRecordingStoragePath,
} from "@/lib/recordings/filename";
import {
    copyExistingRecordingFiles,
    deleteOldRecordingFiles,
} from "@/lib/recordings/storage-files";
import { createUserStorageProvider } from "@/lib/storage/factory";

export interface RecordingStorageState {
    id: string;
    userId: string;
    title: string;
    storagePath: string;
}

export interface RecordingStorageReconciliation {
    changed: boolean;
    storagePath: string;
}

/** Whether the database's exact on-disk key matches the recording title. */
export function recordingStorageNeedsReconciliation(
    state: RecordingStorageState,
): boolean {
    return (
        state.storagePath !==
        buildRecordingStoragePath(
            state.userId,
            state.id,
            state.title,
            audioExtension(state.storagePath),
        )
    );
}

/**
 * Move a recording's audio and existing sidecars to its canonical title-based
 * key, then atomically make that key authoritative in PostgreSQL.
 */
export async function reconcileRecordingStorage(
    state: RecordingStorageState,
): Promise<RecordingStorageReconciliation> {
    const expectedStoragePath = buildRecordingStoragePath(
        state.userId,
        state.id,
        state.title,
        audioExtension(state.storagePath),
    );
    if (expectedStoragePath === state.storagePath) {
        return { changed: false, storagePath: state.storagePath };
    }

    const [shared] = state.storagePath
        ? await db
              .select({ id: recordings.id })
              .from(recordings)
              .where(
                  and(
                      eq(recordings.userId, state.userId),
                      eq(recordings.storagePath, state.storagePath),
                      ne(recordings.id, state.id),
                  ),
              )
              .limit(1)
        : [];
    const storage = await createUserStorageProvider(state.userId);
    const copiedSources = state.storagePath
        ? await copyExistingRecordingFiles(
              storage,
              state.storagePath,
              expectedStoragePath,
          )
        : [];

    const [relocated] = await db
        .update(recordings)
        .set({ storagePath: expectedStoragePath, updatedAt: new Date() })
        .where(
            and(
                eq(recordings.id, state.id),
                eq(recordings.userId, state.userId),
                eq(recordings.storagePath, state.storagePath),
                isNull(recordings.deletedAt),
            ),
        )
        .returning({ storagePath: recordings.storagePath });

    if (!relocated) {
        throw new Error(
            `Recording ${state.id} changed while its storage files were being renamed`,
        );
    }

    if (!shared) {
        await deleteOldRecordingFiles(storage, copiedSources, state.id);
    }

    return { changed: true, storagePath: relocated.storagePath };
}
