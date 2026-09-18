import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    folderExportConfigurations,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type {
    FolderKind,
    FolderOrganization,
    RecordingFolder,
} from "@/types/folder";

export const MAX_FOLDER_NAME_LENGTH = 100;

const ROOTS: ReadonlyArray<{
    kind: "private" | "public";
    name: string;
    sortOrder: number;
}> = [
    { kind: "private", name: "Private", sortOrder: 0 },
    { kind: "public", name: "Public", sortOrder: 1000 },
];

const FOLDER_ORDER_STEP = 1000;

async function scheduleExportProjection(userId: string): Promise<void> {
    await enqueueExportPlansForUser(userId).catch((error) => {
        console.error("Failed to schedule folder export projection:", error);
    });
}

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
    sortOrder: number;
}): RecordingFolder {
    return {
        id: row.id,
        parentId: row.parentId,
        name: decryptText(row.name),
        kind: row.kind,
        sortOrder: row.sortOrder,
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
                sortOrder: root.sortOrder,
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
                sortOrder: recordingFolders.sortOrder,
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

    const siblings = await db
        .select({ sortOrder: recordingFolders.sortOrder })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.userId, input.userId),
                eq(recordingFolders.parentId, parent.id),
            ),
        );
    const sortOrder =
        siblings.reduce(
            (highest, sibling) => Math.max(highest, sibling.sortOrder),
            -FOLDER_ORDER_STEP,
        ) + FOLDER_ORDER_STEP;

    const [created] = await db
        .insert(recordingFolders)
        .values({
            userId: input.userId,
            parentId: parent.id,
            name: encryptText(name),
            nameHash: lookupHash(name),
            kind: "custom",
            sortOrder,
        })
        .returning({
            id: recordingFolders.id,
            parentId: recordingFolders.parentId,
            name: recordingFolders.name,
            kind: recordingFolders.kind,
            sortOrder: recordingFolders.sortOrder,
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
            sortOrder: recordingFolders.sortOrder,
        });
    if (!updated) {
        throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    }
    await scheduleExportProjection(input.userId);
    return serializeFolder(updated);
}

export async function moveFolder(input: {
    userId: string;
    folderId: string;
    parentId: string;
    beforeId?: string | null;
}): Promise<RecordingFolder> {
    const moved = await db.transaction(
        async (tx) => {
            const folders = await tx
                .select({
                    id: recordingFolders.id,
                    parentId: recordingFolders.parentId,
                    name: recordingFolders.name,
                    kind: recordingFolders.kind,
                    sortOrder: recordingFolders.sortOrder,
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

            let destinationRoot = parent;
            while (destinationRoot.parentId) {
                const next = byId.get(destinationRoot.parentId);
                if (!next) break;
                destinationRoot = next;
            }
            if (destinationRoot.kind !== "private") {
                const movedSubtree = new Set([folder.id]);
                let changed = true;
                while (changed) {
                    changed = false;
                    for (const candidate of folders) {
                        if (
                            candidate.parentId &&
                            movedSubtree.has(candidate.parentId) &&
                            !movedSubtree.has(candidate.id)
                        ) {
                            movedSubtree.add(candidate.id);
                            changed = true;
                        }
                    }
                }
                const configured = await tx
                    .select({ id: folderExportConfigurations.id })
                    .from(folderExportConfigurations)
                    .where(
                        and(
                            eq(folderExportConfigurations.userId, input.userId),
                            inArray(folderExportConfigurations.folderId, [
                                ...movedSubtree,
                            ]),
                        ),
                    )
                    .limit(1);
                if (configured.length > 0) {
                    throw new AppError(
                        ErrorCode.INVALID_INPUT,
                        "Remove filesystem exports before moving this folder outside Private",
                        400,
                    );
                }
            }

            const siblings = folders
                .filter(
                    (item) =>
                        item.parentId === parent.id && item.id !== folder.id,
                )
                .sort(
                    (left, right) =>
                        left.sortOrder - right.sortOrder ||
                        decryptText(left.name).localeCompare(
                            decryptText(right.name),
                        ),
                );
            let insertionIndex = siblings.length;
            if (input.beforeId != null) {
                insertionIndex = siblings.findIndex(
                    (item) => item.id === input.beforeId,
                );
                if (insertionIndex < 0) {
                    throw new AppError(
                        ErrorCode.INVALID_INPUT,
                        "The requested folder position is invalid",
                        400,
                    );
                }
            }
            siblings.splice(insertionIndex, 0, {
                ...folder,
                parentId: parent.id,
            });

            for (const [index, sibling] of siblings.entries()) {
                await tx
                    .update(recordingFolders)
                    .set({
                        parentId: parent.id,
                        sortOrder: index * FOLDER_ORDER_STEP,
                        ...(sibling.id === folder.id
                            ? { updatedAt: new Date() }
                            : {}),
                    })
                    .where(
                        and(
                            eq(recordingFolders.id, sibling.id),
                            eq(recordingFolders.userId, input.userId),
                        ),
                    );
            }

            const movedIndex = siblings.findIndex(
                (sibling) => sibling.id === folder.id,
            );
            if (movedIndex < 0) {
                throw new AppError(
                    ErrorCode.INTERNAL_ERROR,
                    "Folder position could not be saved",
                    500,
                );
            }
            return serializeFolder({
                ...folder,
                parentId: parent.id,
                sortOrder: movedIndex * FOLDER_ORDER_STEP,
            });
        },
        { isolationLevel: "serializable" },
    );
    await scheduleExportProjection(input.userId);
    return moved;
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
    await scheduleExportProjection(userId);
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

    await db.transaction(async (tx) => {
        await tx
            .insert(recordingFolderAssignments)
            .values({
                userId: input.userId,
                recordingId: recording[0].id,
                folderId: folder[0].id,
            })
            .onConflictDoNothing();

        const [folders, assignments] = await Promise.all([
            tx
                .select({
                    id: recordingFolders.id,
                    parentId: recordingFolders.parentId,
                })
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, input.userId)),
            tx
                .select({ folderId: recordingFolderAssignments.folderId })
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.userId, input.userId),
                        eq(
                            recordingFolderAssignments.recordingId,
                            input.recordingId,
                        ),
                    ),
                ),
        ]);
        const selected = new Set(assignments.map((item) => item.folderId));
        const byId = new Map(folders.map((item) => [item.id, item]));
        const redundant = new Set<string>();
        for (const assignment of assignments) {
            let current = byId.get(assignment.folderId);
            while (current?.parentId) {
                if (selected.has(current.parentId)) {
                    redundant.add(current.parentId);
                }
                current = byId.get(current.parentId);
            }
        }
        if (redundant.size > 0) {
            await tx
                .delete(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.userId, input.userId),
                        eq(
                            recordingFolderAssignments.recordingId,
                            input.recordingId,
                        ),
                        inArray(recordingFolderAssignments.folderId, [
                            ...redundant,
                        ]),
                    ),
                );
        }
    });
    await scheduleExportProjection(input.userId);
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
    await scheduleExportProjection(input.userId);
}
