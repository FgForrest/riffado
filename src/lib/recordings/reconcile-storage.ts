import { and, eq, isNull, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import {
    audioExtension,
    buildRecordingStorageFilename,
} from "@/lib/recordings/filename";
import {
    copyExistingRecordingFiles,
    deleteOldRecordingFiles,
    sidecarKey,
} from "@/lib/recordings/storage-files";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { StorageProvider } from "@/lib/storage/types";

const MAX_FILENAME_CANDIDATES = 1_000;
const STORAGE_FILENAME_UNIQUE =
    "recordings_user_id_storage_filename_stem_unique";

export interface RecordingStorageState {
    id: string;
    userId: string;
    title: string;
    storagePath: string;
    storageFilename: string | null;
}

export interface RecordingStorageReconciliation {
    changed: boolean;
    storagePath: string;
    storageFilename: string;
}

/** Whether the database's exact on-disk key matches the recording title. */
export function recordingStorageNeedsReconciliation(
    state: RecordingStorageState,
): boolean {
    if (!state.storageFilename) return true;
    if (
        !storageFilenameMatchesTitle(
            state.storageFilename,
            state.title,
            audioExtension(state.storagePath),
        )
    ) {
        return true;
    }
    return state.storagePath !== `${state.userId}/${state.storageFilename}`;
}

/** A reserved name may be the base title or one of its numeric collisions. */
export function storageFilenameMatchesTitle(
    filename: string,
    title: string,
    extension: string,
): boolean {
    if (filename === buildRecordingStorageFilename(title, extension)) {
        return true;
    }
    const dot = filename.lastIndexOf(".");
    const stem = dot === -1 ? filename : filename.slice(0, dot);
    const match = /-(\d+)$/.exec(stem);
    if (!match) return false;
    const index = Number(match[1]);
    return (
        Number.isInteger(index) &&
        index > 0 &&
        index < MAX_FILENAME_CANDIDATES &&
        filename === buildRecordingStorageFilename(title, extension, index)
    );
}

function isStorageFilenameConflict(error: unknown): boolean {
    const direct = error as { code?: unknown; constraint?: unknown };
    const cause = (error as { cause?: unknown }).cause as
        | { code?: unknown; constraint?: unknown }
        | undefined;
    return (
        (direct.code === "23505" &&
            direct.constraint === STORAGE_FILENAME_UNIQUE) ||
        (cause?.code === "23505" &&
            cause.constraint === STORAGE_FILENAME_UNIQUE)
    );
}

async function storageKeyExists(
    storage: StorageProvider,
    audioPath: string,
): Promise<boolean> {
    const results = await Promise.all([
        storage.exists(audioPath),
        storage.exists(sidecarKey(audioPath, "transcript")),
        storage.exists(sidecarKey(audioPath, "summary")),
        storage.exists(sidecarKey(audioPath, "transcript", "plaud")),
        storage.exists(sidecarKey(audioPath, "summary", "plaud")),
        storage.exists(sidecarKey(audioPath, "transcript", "riffado")),
        storage.exists(sidecarKey(audioPath, "summary", "riffado")),
        storage.exists(sidecarKey(audioPath, "transcript", "mixed")),
    ]);
    return results.some(Boolean);
}

async function reserveStorageFilename(
    state: RecordingStorageState,
    storage: StorageProvider,
): Promise<string> {
    const extension = audioExtension(state.storagePath);
    for (let index = 0; index < MAX_FILENAME_CANDIDATES; index++) {
        const candidate = buildRecordingStorageFilename(
            state.title,
            extension,
            index,
        );
        const candidatePath = `${state.userId}/${candidate}`;
        const [holder] = await db
            .select({ id: recordings.id })
            .from(recordings)
            .where(
                and(
                    eq(recordings.userId, state.userId),
                    ne(recordings.id, state.id),
                    isNull(recordings.deletedAt),
                    or(
                        eq(recordings.storageFilename, candidate),
                        eq(recordings.storagePath, candidatePath),
                    ),
                ),
            )
            .limit(1);
        if (holder) continue;
        if (
            candidatePath !== state.storagePath &&
            (await storageKeyExists(storage, candidatePath))
        ) {
            continue;
        }

        try {
            const currentNameCondition = state.storageFilename
                ? eq(recordings.storageFilename, state.storageFilename)
                : isNull(recordings.storageFilename);
            const [reserved] = await db
                .update(recordings)
                .set({ storageFilename: candidate, updatedAt: new Date() })
                .where(
                    and(
                        eq(recordings.id, state.id),
                        eq(recordings.userId, state.userId),
                        currentNameCondition,
                        isNull(recordings.deletedAt),
                    ),
                )
                .returning({ storageFilename: recordings.storageFilename });
            if (!reserved?.storageFilename) {
                throw new Error(
                    `Recording ${state.id} changed while its storage filename was being reserved`,
                );
            }
            return reserved.storageFilename;
        } catch (error) {
            if (isStorageFilenameConflict(error)) continue;
            throw error;
        }
    }
    throw new Error(
        `Unable to allocate a readable storage filename for recording ${state.id}`,
    );
}

/**
 * Move a recording's audio and existing sidecars to its canonical title-based
 * key, then atomically make that key authoritative in PostgreSQL.
 */
export async function reconcileRecordingStorage(
    state: RecordingStorageState,
): Promise<RecordingStorageReconciliation> {
    const storage = await createUserStorageProvider(state.userId);
    const storageFilename =
        state.storageFilename &&
        storageFilenameMatchesTitle(
            state.storageFilename,
            state.title,
            audioExtension(state.storagePath),
        )
            ? state.storageFilename
            : await reserveStorageFilename(state, storage);
    const expectedStoragePath = `${state.userId}/${storageFilename}`;
    if (expectedStoragePath === state.storagePath) {
        return {
            changed: storageFilename !== state.storageFilename,
            storagePath: state.storagePath,
            storageFilename,
        };
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
                eq(recordings.storageFilename, storageFilename),
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

    return {
        changed: true,
        storagePath: relocated.storagePath,
        storageFilename,
    };
}
