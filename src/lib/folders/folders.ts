import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    recordingFolderAssignments,
    recordingFolders,
    recordings,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type {
    FolderKind,
    FolderOrganization,
    RecordingFolder,
} from "@/types/folder";

export const MAX_FOLDER_NAME_LENGTH = 100;

const ROOTS: ReadonlyArray<{ kind: "private" | "public"; name: string }> = [
    { kind: "private", name: "Private" },
    { kind: "public", name: "Public" },
];

function normalizeName(value: string): string {
    const name = value.trim().replace(/\s+/g, " ");
    if (!name) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "A folder needs a name",
            400,
            { field: "name" },
        );
    }
    if (name.length > MAX_FOLDER_NAME_LENGTH) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `Folder names must be ${MAX_FOLDER_NAME_LENGTH} characters or fewer`,
            400,
            { field: "name" },
        );
    }
    return name;
}

function serializeFolder(row: {
    id: string;
    parentId: string | null;
    name: string;
    kind: FolderKind;
}): RecordingFolder {
    return {
        id: row.id,
        parentId: row.parentId,
        name: decryptText(row.name),
        kind: row.kind,
    };
}

export async function ensureRootFolders(userId: string): Promise<void> {
    await db
        .insert(recordingFolders)
        .values(
            ROOTS.map((root) => ({
                userId,
                parentId: null,
                name: encryptText(root.name),
                nameHash: lookupHash(root.name),
                kind: root.kind,
            })),
        )
        .onConflictDoNothing();
}

export async function listFolderOrganization(
    userId: string,
): Promise<FolderOrganization> {
    await ensureRootFolders(userId);
    const [folderRows, assignmentRows] = await Promise.all([
        db
            .select({
                id: recordingFolders.id,
                parentId: recordingFolders.parentId,
                name: recordingFolders.name,
                kind: recordingFolders.kind,
            })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, userId)),
        db
            .select({
                recordingId: recordingFolderAssignments.recordingId,
                folderId: recordingFolderAssignments.folderId,
            })
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.userId, userId)),
    ]);

    return {
        folders: folderRows.map(serializeFolder),
        assignments: assignmentRows,
    };
}

export async function createFolder(input: {
    userId: string;
    parentId: string;
    name: string;
}): Promise<RecordingFolder> {
    const name = normalizeName(input.name);
    const [parent] = await db
        .select({ id: recordingFolders.id })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.id, input.parentId),
                eq(recordingFolders.userId, input.userId),
            ),
        )
        .limit(1);
    if (!parent) {
        throw new AppError(ErrorCode.NOT_FOUND, "Parent folder not found", 404);
    }

    const [created] = await db
        .insert(recordingFolders)
        .values({
            userId: input.userId,
            parentId: parent.id,
            name: encryptText(name),
            nameHash: lookupHash(name),
            kind: "custom",
        })
        .returning({
            id: recordingFolders.id,
            parentId: recordingFolders.parentId,
            name: recordingFolders.name,
            kind: recordingFolders.kind,
        });
    if (!created) {
        throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            "Folder could not be created",
            500,
        );
    }
    return serializeFolder(created);
}

export async function renameFolder(input: {
    userId: string;
    folderId: string;
    name: string;
}): Promise<RecordingFolder> {
    const name = normalizeName(input.name);
    const [updated] = await db
        .update(recordingFolders)
        .set({
            name: encryptText(name),
            nameHash: lookupHash(name),
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(recordingFolders.id, input.folderId),
                eq(recordingFolders.userId, input.userId),
                eq(recordingFolders.kind, "custom"),
            ),
        )
        .returning({
            id: recordingFolders.id,
            parentId: recordingFolders.parentId,
            name: recordingFolders.name,
            kind: recordingFolders.kind,
        });
    if (!updated) {
        throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    }
    return serializeFolder(updated);
}

export async function moveFolder(input: {
    userId: string;
    folderId: string;
    parentId: string;
}): Promise<RecordingFolder> {
    return db.transaction(
        async (tx) => {
            const folders = await tx
                .select({
                    id: recordingFolders.id,
                    parentId: recordingFolders.parentId,
                    name: recordingFolders.name,
                    kind: recordingFolders.kind,
                })
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, input.userId));
            const folder = folders.find((item) => item.id === input.folderId);
            const parent = folders.find((item) => item.id === input.parentId);
            if (!folder || folder.kind !== "custom" || !parent) {
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Folder not found",
                    404,
                );
            }
            if (folder.id === parent.id) {
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "A folder cannot contain itself",
                    400,
                );
            }

            const byId = new Map(folders.map((item) => [item.id, item]));
            let ancestor: typeof parent | undefined = parent;
            while (ancestor) {
                if (ancestor.id === folder.id) {
                    throw new AppError(
                        ErrorCode.INVALID_INPUT,
                        "A folder cannot be moved inside one of its subfolders",
                        400,
                    );
                }
                ancestor = ancestor.parentId
                    ? byId.get(ancestor.parentId)
                    : undefined;
            }

            const [updated] = await tx
                .update(recordingFolders)
                .set({ parentId: parent.id, updatedAt: new Date() })
                .where(
                    and(
                        eq(recordingFolders.id, folder.id),
                        eq(recordingFolders.userId, input.userId),
                        eq(recordingFolders.kind, "custom"),
                    ),
                )
                .returning({
                    id: recordingFolders.id,
                    parentId: recordingFolders.parentId,
                    name: recordingFolders.name,
                    kind: recordingFolders.kind,
                });
            if (!updated) {
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Folder not found",
                    404,
                );
            }
            return serializeFolder(updated);
        },
        { isolationLevel: "serializable" },
    );
}

export async function deleteFolder(
    userId: string,
    folderId: string,
): Promise<void> {
    const deleted = await db
        .delete(recordingFolders)
        .where(
            and(
                eq(recordingFolders.id, folderId),
                eq(recordingFolders.userId, userId),
                eq(recordingFolders.kind, "custom"),
            ),
        )
        .returning({ id: recordingFolders.id });
    if (deleted.length === 0) {
        throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    }
}

export async function addRecordingToFolder(input: {
    userId: string;
    recordingId: string;
    folderId: string;
}): Promise<void> {
    const [recording, folder] = await Promise.all([
        db
            .select({ id: recordings.id })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, input.recordingId),
                    eq(recordings.userId, input.userId),
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1),
        db
            .select({ id: recordingFolders.id, kind: recordingFolders.kind })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.id, input.folderId),
                    eq(recordingFolders.userId, input.userId),
                ),
            )
            .limit(1),
    ]);
    if (!recording[0] || !folder[0]) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording or folder not found",
            404,
        );
    }
    if (folder[0].kind === "private") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Every recording already appears in Private",
            400,
        );
    }

    await db
        .insert(recordingFolderAssignments)
        .values({
            userId: input.userId,
            recordingId: recording[0].id,
            folderId: folder[0].id,
        })
        .onConflictDoNothing();
}

export async function removeRecordingFromFolder(input: {
    userId: string;
    recordingId: string;
    folderId: string;
}): Promise<void> {
    await db
        .delete(recordingFolderAssignments)
        .where(
            and(
                eq(recordingFolderAssignments.userId, input.userId),
                eq(recordingFolderAssignments.recordingId, input.recordingId),
                eq(recordingFolderAssignments.folderId, input.folderId),
            ),
        );
}
