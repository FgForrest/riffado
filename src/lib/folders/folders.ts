import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    asyncJobs,
    folderExportConfigurations,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    transcriptions,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { promoteRecordingPeople } from "@/lib/knowledge/people";
import {
    assertOrgScopeWritable,
    getOrgUserId,
    isOrgAccount,
} from "@/lib/org/config";
import { notifyOrgChange } from "@/lib/org/events";
import { recordingJobSubject } from "@/lib/sharing/access";
import type {
    FolderKind,
    FolderOrganization,
    FolderScope,
    RecordingFolder,
} from "@/types/folder";

export const MAX_FOLDER_NAME_LENGTH = 100;

/** Stored name of the Organization root; the UI labels roots by kind. */
export const ORG_ROOT_NAME = "Organization";

const FOLDER_ORDER_STEP = 1000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RootSpec = { kind: "private" | "public"; name: string; sortOrder: number };

const PRIVATE_ROOT: RootSpec = {
    kind: "private",
    name: "Private",
    sortOrder: 0,
};
const LEGACY_PUBLIC_ROOT: RootSpec = {
    kind: "public",
    name: "Public",
    sortOrder: 1000,
};
const ORG_ROOT: RootSpec = {
    kind: "public",
    name: ORG_ROOT_NAME,
    sortOrder: 1000,
};

interface FolderRow {
    id: string;
    userId: string;
    parentId: string | null;
    name: string;
    kind: FolderKind;
    sortOrder: number;
    version: number;
}

const folderColumns = {
    id: recordingFolders.id,
    userId: recordingFolders.userId,
    parentId: recordingFolders.parentId,
    name: recordingFolders.name,
    kind: recordingFolders.kind,
    sortOrder: recordingFolders.sortOrder,
    version: recordingFolders.version,
};

/**
 * A folder the caller may act on, and in which tree it lives.
 *
 * `ownerId` is whose rows the tree is made of: the caller for Private, the
 * organization account for Organization.
 */
interface AccessibleFolder {
    folder: FolderRow;
    scope: FolderScope;
    ownerId: string;
}

async function scheduleExportProjection(userId: string): Promise<void> {
    await enqueueExportPlansForUser(userId).catch((error) => {
        console.error("Failed to schedule folder export projection:", error);
    });
}

/** Everyone's view of the tree, and the organization's exports of it, are stale. */
async function orgTreeChanged(): Promise<void> {
    await notifyOrgChange({ type: "tree" });
    const orgUserId = await getOrgUserId();
    if (orgUserId) await scheduleExportProjection(orgUserId);
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

function serializeFolder(row: FolderRow, scope: FolderScope): RecordingFolder {
    return {
        id: row.id,
        parentId: row.parentId,
        name: decryptText(row.name),
        kind: row.kind,
        sortOrder: row.sortOrder,
        scope,
        version: row.version,
    };
}

function folderNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
}

function staleFolder(): AppError {
    return new AppError(
        ErrorCode.CONFLICT,
        "Someone else changed this folder. Refresh and try again.",
        409,
    );
}

function rootsFor(isOrg: boolean): RootSpec[] {
    if (isOrg) return [ORG_ROOT];
    // Hosted keeps the per-user Public root it always had. Self-host replaces
    // it with the shared Organization tree.
    return env.IS_HOSTED ? [PRIVATE_ROOT, LEGACY_PUBLIC_ROOT] : [PRIVATE_ROOT];
}

async function insertRoots(
    executor: Pick<typeof db, "insert">,
    userId: string,
    roots: RootSpec[],
): Promise<void> {
    if (roots.length === 0) return;
    await executor
        .insert(recordingFolders)
        .values(
            roots.map((root) => ({
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

/** Create the root folders an account is entitled to, if missing. */
export async function ensureRootFolders(userId: string): Promise<void> {
    await insertRoots(db, userId, rootsFor(await isOrgAccount(userId)));
}

/** Create the organization account's root inside an existing transaction. */
export async function ensureOrgRootFolder(
    tx: Pick<typeof db, "insert">,
    orgUserId: string,
): Promise<void> {
    await insertRoots(tx, orgUserId, [ORG_ROOT]);
}

/**
 * Resolve a folder id to something the caller may act on.
 *
 * Private folders are their owner's alone. Organization folders are open to
 * every account while the scope is enabled.
 */
async function resolveFolder(
    executor: Pick<typeof db, "select">,
    userId: string,
    folderId: string,
    orgUserId: string | null,
): Promise<AccessibleFolder | null> {
    const [folder] = await executor
        .select(folderColumns)
        .from(recordingFolders)
        .where(eq(recordingFolders.id, folderId))
        .limit(1);
    if (!folder) return null;
    if (orgUserId && folder.userId === orgUserId) {
        return { folder, scope: "org", ownerId: orgUserId };
    }
    if (folder.userId === userId) {
        // The organization account's folders are the Organization tree even
        // while the scope is hidden, so its writes still meet the read-only
        // guard instead of passing as a private tree.
        return (await isOrgAccount(userId))
            ? { folder, scope: "org", ownerId: userId }
            : { folder, scope: "personal", ownerId: userId };
    }
    return null;
}

/** Changes to the Organization tree need the scope to be writable. */
function assertWritable(target: AccessibleFolder): void {
    if (target.scope === "org") assertOrgScopeWritable();
}

/**
 * Serialize Organization-tree changes.
 *
 * Moves, folder deletions and unshares read assignments and then write them;
 * interleaved at read committed, a member's move could survive an owner's
 * unshare, or a folder delete could cascade away a recording moved into it a
 * moment earlier. One transaction-scoped lock rules both out.
 */
async function lockOrgTree(tx: Tx): Promise<void> {
    await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('riffado:org-tree'))`,
    );
}

/**
 * Lock the recording row, as the content upserts do, so an Organization run
 * that is about to commit and an unshare cannot pass each other.
 */
async function lockRecording(tx: Tx, recordingId: string): Promise<void> {
    await tx
        .select({ id: recordings.id })
        .from(recordings)
        .where(eq(recordings.id, recordingId))
        .for("update");
}

async function listTreeFolders(
    executor: Pick<typeof db, "select">,
    ownerId: string,
): Promise<FolderRow[]> {
    return executor
        .select(folderColumns)
        .from(recordingFolders)
        .where(eq(recordingFolders.userId, ownerId));
}

function subtreeIds(folders: ReadonlyArray<FolderRow>, rootId: string) {
    const ids = new Set([rootId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const folder of folders) {
            if (
                folder.parentId &&
                ids.has(folder.parentId) &&
                !ids.has(folder.id)
            ) {
                ids.add(folder.id);
                changed = true;
            }
        }
    }
    return ids;
}

/**
 * Every folder and assignment the caller can see.
 *
 * A regular account sees its Private tree plus the whole Organization tree.
 * The organization account sees only the Organization tree.
 */
export async function listFolderOrganization(
    userId: string,
): Promise<FolderOrganization> {
    const [isOrg, orgUserId] = await Promise.all([
        isOrgAccount(userId),
        getOrgUserId(),
    ]);
    await insertRoots(db, userId, rootsFor(isOrg));

    const personal = isOrg
        ? { folders: [], assignments: [] }
        : await listTreeOrganization(userId, "personal", userId);
    const org = orgUserId
        ? await listTreeOrganization(orgUserId, "org")
        : { folders: [], assignments: [] };

    return {
        folders: [...personal.folders, ...org.folders],
        assignments: [...personal.assignments, ...org.assignments],
    };
}

/**
 * The caller's Private tree only. For per-user consumers -- filesystem
 * exports, the backup archive -- that must never see Organization folders.
 */
export async function listPersonalFolderOrganization(
    userId: string,
): Promise<FolderOrganization> {
    await insertRoots(db, userId, rootsFor(await isOrgAccount(userId)));
    return listTreeOrganization(userId, "personal", userId);
}

/**
 * The tree a filesystem export of `userId` projects: their Private tree, or
 * for the organization account the whole Organization tree with everyone's
 * shared recordings.
 */
export async function listExportFolderOrganization(
    userId: string,
): Promise<FolderOrganization> {
    if (await isOrgAccount(userId)) {
        await insertRoots(db, userId, [ORG_ROOT]);
        return listTreeOrganization(userId, "org");
    }
    return listPersonalFolderOrganization(userId);
}

async function listTreeOrganization(
    ownerId: string,
    scope: FolderScope,
    assignmentUserId?: string,
): Promise<FolderOrganization> {
    const [folderRows, assignmentRows] = await Promise.all([
        listTreeFolders(db, ownerId),
        db
            .select({
                recordingId: recordingFolderAssignments.recordingId,
                folderId: recordingFolderAssignments.folderId,
            })
            .from(recordingFolderAssignments)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, recordingFolderAssignments.folderId),
            )
            .innerJoin(
                recordings,
                eq(recordings.id, recordingFolderAssignments.recordingId),
            )
            .where(
                and(
                    eq(recordingFolders.userId, ownerId),
                    isNull(recordings.deletedAt),
                    assignmentUserId
                        ? eq(
                              recordingFolderAssignments.userId,
                              assignmentUserId,
                          )
                        : undefined,
                ),
            ),
    ]);
    return {
        folders: folderRows.map((row) => serializeFolder(row, scope)),
        assignments: assignmentRows,
    };
}

export async function createFolder(input: {
    userId: string;
    parentId: string;
    name: string;
}): Promise<RecordingFolder> {
    const name = normalizeName(input.name);
    const orgUserId = await getOrgUserId();
    const parent = await resolveFolder(
        db,
        input.userId,
        input.parentId,
        orgUserId,
    );
    if (!parent) {
        throw new AppError(ErrorCode.NOT_FOUND, "Parent folder not found", 404);
    }
    assertWritable(parent);

    const siblings = await db
        .select({ sortOrder: recordingFolders.sortOrder })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.userId, parent.ownerId),
                eq(recordingFolders.parentId, parent.folder.id),
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
            userId: parent.ownerId,
            parentId: parent.folder.id,
            name: encryptText(name),
            nameHash: lookupHash(name),
            kind: "custom",
            sortOrder,
            createdByUserId: input.userId,
        })
        .returning(folderColumns);
    if (!created) {
        throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            "Folder could not be created",
            500,
        );
    }
    if (parent.scope === "org") await orgTreeChanged();
    return serializeFolder(created, parent.scope);
}

export async function renameFolder(input: {
    userId: string;
    folderId: string;
    name: string;
    /** The version the caller last saw; a mismatch is a 409. */
    version?: number;
}): Promise<RecordingFolder> {
    const name = normalizeName(input.name);
    const orgUserId = await getOrgUserId();
    const target = await resolveFolder(
        db,
        input.userId,
        input.folderId,
        orgUserId,
    );
    if (!target || target.folder.kind !== "custom") throw folderNotFound();
    assertWritable(target);
    if (
        input.version !== undefined &&
        input.version !== target.folder.version
    ) {
        throw staleFolder();
    }

    const [updated] = await db
        .update(recordingFolders)
        .set({
            name: encryptText(name),
            nameHash: lookupHash(name),
            version: target.folder.version + 1,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(recordingFolders.id, target.folder.id),
                eq(recordingFolders.userId, target.ownerId),
                eq(recordingFolders.version, target.folder.version),
            ),
        )
        .returning(folderColumns);
    if (!updated) throw staleFolder();

    if (target.scope === "org") {
        await orgTreeChanged();
    } else {
        await scheduleExportProjection(input.userId);
    }
    return serializeFolder(updated, target.scope);
}

export async function moveFolder(input: {
    userId: string;
    folderId: string;
    parentId: string;
    beforeId?: string | null;
    /** The version the caller last saw; a mismatch is a 409. */
    version?: number;
}): Promise<RecordingFolder> {
    const orgUserId = await getOrgUserId();
    const moved = await db.transaction(
        async (tx) => {
            if (orgUserId) await lockOrgTree(tx);
            const target = await resolveFolder(
                tx,
                input.userId,
                input.folderId,
                orgUserId,
            );
            if (!target || target.folder.kind !== "custom") {
                throw folderNotFound();
            }
            assertWritable(target);
            if (
                input.version !== undefined &&
                input.version !== target.folder.version
            ) {
                throw staleFolder();
            }
            const folders = await listTreeFolders(tx, target.ownerId);
            const folder = folders.find((item) => item.id === input.folderId);
            const parent = folders.find((item) => item.id === input.parentId);
            if (!folder || !parent) throw folderNotFound();
            if (folder.id === parent.id) {
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "A folder cannot contain itself",
                    400,
                );
            }

            const byId = new Map(folders.map((item) => [item.id, item]));
            let ancestor: FolderRow | undefined = parent;
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
                const configured = await tx
                    .select({ id: folderExportConfigurations.id })
                    .from(folderExportConfigurations)
                    .where(
                        inArray(folderExportConfigurations.folderId, [
                            ...subtreeIds(folders, folder.id),
                        ]),
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
                            ? {
                                  updatedAt: new Date(),
                                  version: folder.version + 1,
                              }
                            : {}),
                    })
                    .where(
                        and(
                            eq(recordingFolders.id, sibling.id),
                            eq(recordingFolders.userId, target.ownerId),
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
            return {
                scope: target.scope,
                folder: serializeFolder(
                    {
                        ...folder,
                        parentId: parent.id,
                        sortOrder: movedIndex * FOLDER_ORDER_STEP,
                        version: folder.version + 1,
                    },
                    target.scope,
                ),
            };
        },
        { isolationLevel: "serializable" },
    );
    if (moved.scope === "org") {
        await orgTreeChanged();
    } else {
        await scheduleExportProjection(input.userId);
    }
    return moved.folder;
}

/**
 * Delete a folder and its subfolders.
 *
 * In the Organization tree nothing is unshared by it: every recording filed
 * anywhere in the subtree lands in the Organization root instead. Folders
 * holding an export configuration can only be deleted by the organization
 * account, which is the one that configured it.
 */
export async function deleteFolder(
    userId: string,
    folderId: string,
): Promise<void> {
    const orgUserId = await getOrgUserId();
    const scope = await db.transaction(async (tx) => {
        if (orgUserId) await lockOrgTree(tx);
        const target = await resolveFolder(tx, userId, folderId, orgUserId);
        if (!target || target.folder.kind !== "custom") throw folderNotFound();
        assertWritable(target);

        if (target.scope === "org" && orgUserId) {
            const folders = await listTreeFolders(tx, orgUserId);
            const subtree = [...subtreeIds(folders, target.folder.id)];
            if (userId !== orgUserId) {
                const configured = await tx
                    .select({ id: folderExportConfigurations.id })
                    .from(folderExportConfigurations)
                    .where(
                        inArray(folderExportConfigurations.folderId, subtree),
                    )
                    .limit(1);
                if (configured.length > 0) {
                    throw new AppError(
                        ErrorCode.FORBIDDEN,
                        "Only the organization account can delete a folder that is exported",
                        403,
                    );
                }
            }
            const root = folders.find(
                (folder) =>
                    folder.parentId === null && folder.kind === "public",
            );
            if (root) {
                const displaced = await tx
                    .select({
                        userId: recordingFolderAssignments.userId,
                        recordingId: recordingFolderAssignments.recordingId,
                    })
                    .from(recordingFolderAssignments)
                    .where(
                        inArray(recordingFolderAssignments.folderId, subtree),
                    );
                const remainingOrgFolders = folders
                    .filter((folder) => !subtree.includes(folder.id))
                    .map((folder) => folder.id);
                const stillFiled =
                    displaced.length > 0 && remainingOrgFolders.length > 0
                        ? await tx
                              .select({
                                  recordingId:
                                      recordingFolderAssignments.recordingId,
                              })
                              .from(recordingFolderAssignments)
                              .where(
                                  and(
                                      inArray(
                                          recordingFolderAssignments.recordingId,
                                          displaced.map(
                                              (row) => row.recordingId,
                                          ),
                                      ),
                                      inArray(
                                          recordingFolderAssignments.folderId,
                                          remainingOrgFolders,
                                      ),
                                  ),
                              )
                        : [];
                const filed = new Set(stillFiled.map((row) => row.recordingId));
                const toRoot = new Map<string, string>();
                for (const row of displaced) {
                    if (!filed.has(row.recordingId)) {
                        toRoot.set(row.recordingId, row.userId);
                    }
                }
                if (toRoot.size > 0) {
                    await tx
                        .insert(recordingFolderAssignments)
                        .values(
                            [...toRoot].map(([recordingId, ownerId]) => ({
                                userId: ownerId,
                                recordingId,
                                folderId: root.id,
                            })),
                        )
                        .onConflictDoNothing();
                }
            }
        }

        await tx
            .delete(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.id, target.folder.id),
                    eq(recordingFolders.userId, target.ownerId),
                ),
            );
        return target.scope;
    });
    if (scope === "org") {
        await orgTreeChanged();
    } else {
        await scheduleExportProjection(userId);
    }
}

async function requireOwnedRecording(
    executor: Pick<typeof db, "select">,
    userId: string,
    recordingId: string,
): Promise<void> {
    const [recording] = await executor
        .select({ id: recordings.id })
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
            ErrorCode.NOT_FOUND,
            "Recording or folder not found",
            404,
        );
    }
}

/** Drop assignments to ancestors of another assignment in the same tree. */
async function pruneRedundantAssignments(
    tx: Tx,
    treeOwnerId: string,
    recordingId: string,
): Promise<void> {
    const [folders, assignments] = await Promise.all([
        tx
            .select({
                id: recordingFolders.id,
                parentId: recordingFolders.parentId,
            })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, treeOwnerId)),
        tx
            .select({ folderId: recordingFolderAssignments.folderId })
            .from(recordingFolderAssignments)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, recordingFolderAssignments.folderId),
            )
            .where(
                and(
                    eq(recordingFolders.userId, treeOwnerId),
                    eq(recordingFolderAssignments.recordingId, recordingId),
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
                    eq(recordingFolderAssignments.recordingId, recordingId),
                    inArray(recordingFolderAssignments.folderId, [
                        ...redundant,
                    ]),
                ),
            );
    }
}

/**
 * File a recording in a folder.
 *
 * Filing in the Organization tree is sharing, so only the owner may do it.
 */
export async function addRecordingToFolder(input: {
    userId: string;
    recordingId: string;
    folderId: string;
}): Promise<void> {
    const orgUserId = await getOrgUserId();
    const target = await resolveFolder(
        db,
        input.userId,
        input.folderId,
        orgUserId,
    );
    if (!target) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording or folder not found",
            404,
        );
    }
    await requireOwnedRecording(db, input.userId, input.recordingId);
    if (target.folder.kind === "private") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Every recording already appears in Private",
            400,
        );
    }
    assertWritable(target);

    await db.transaction(async (tx) => {
        if (target.scope === "org") await lockOrgTree(tx);
        await tx
            .insert(recordingFolderAssignments)
            .values({
                userId: input.userId,
                recordingId: input.recordingId,
                folderId: target.folder.id,
            })
            .onConflictDoNothing();
        await pruneRedundantAssignments(tx, target.ownerId, input.recordingId);
    });
    if (target.scope === "org") {
        await promoteSharedNames(
            input.recordingId,
            input.userId,
            target.ownerId,
        );
        await orgTreeChanged();
    } else {
        await scheduleExportProjection(input.userId);
    }
}

/**
 * Sharing shows the owner's transcripts in the Organization view until the
 * organization has its own; every name confirmed on them becomes an
 * Organization person, so the shared view and everyone's knowledge base
 * agree on who is speaking.
 */
async function promoteSharedNames(
    recordingId: string,
    ownerUserId: string,
    orgUserId: string,
): Promise<void> {
    const [own] = await db
        .select({ id: transcriptions.id })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, orgUserId),
            ),
        )
        .limit(1);
    if (own) return;
    await promoteRecordingPeople(recordingId, ownerUserId, orgUserId);
}

/**
 * Take a recording out of one folder.
 *
 * In the Organization tree only the owner may do this. When it was the last
 * Organization folder, the recording is unshared: its Organization view is
 * deleted for everyone.
 */
export async function removeRecordingFromFolder(input: {
    userId: string;
    recordingId: string;
    folderId: string;
}): Promise<void> {
    const orgUserId = await getOrgUserId();
    const target = await resolveFolder(
        db,
        input.userId,
        input.folderId,
        orgUserId,
    );
    if (!target) return;

    if (target.scope === "personal") {
        await db
            .delete(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.userId, input.userId),
                    eq(
                        recordingFolderAssignments.recordingId,
                        input.recordingId,
                    ),
                    eq(recordingFolderAssignments.folderId, input.folderId),
                ),
            );
        await scheduleExportProjection(input.userId);
        return;
    }

    await requireRecordingOwnerForSharing(input.userId, input.recordingId);
    await db.transaction(async (tx) => {
        await lockOrgTree(tx);
        await lockRecording(tx, input.recordingId);
        await tx
            .delete(recordingFolderAssignments)
            .where(
                and(
                    eq(
                        recordingFolderAssignments.recordingId,
                        input.recordingId,
                    ),
                    eq(recordingFolderAssignments.folderId, input.folderId),
                ),
            );
        await deleteOrgViewIfUnshared(tx, target.ownerId, input.recordingId);
    });
    await orgTreeChanged();
}

/** Remove a recording from the whole Organization tree. Owner only. */
export async function unshareRecording(
    userId: string,
    recordingId: string,
): Promise<void> {
    const orgUserId = await getOrgUserId();
    if (!orgUserId) return;
    await requireRecordingOwnerForSharing(userId, recordingId);
    await db.transaction(async (tx) => {
        await lockOrgTree(tx);
        await lockRecording(tx, recordingId);
        const orgFolderIds = (
            await tx
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, orgUserId))
        ).map((row) => row.id);
        if (orgFolderIds.length > 0) {
            await tx
                .delete(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.recordingId, recordingId),
                        inArray(
                            recordingFolderAssignments.folderId,
                            orgFolderIds,
                        ),
                    ),
                );
        }
        await deleteOrgViewIfUnshared(tx, orgUserId, recordingId);
    });
    await orgTreeChanged();
}

async function requireRecordingOwnerForSharing(
    userId: string,
    recordingId: string,
): Promise<void> {
    const [recording] = await db
        .select({ userId: recordings.userId })
        .from(recordings)
        .where(
            and(eq(recordings.id, recordingId), isNull(recordings.deletedAt)),
        )
        .limit(1);
    if (!recording) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording or folder not found",
            404,
        );
    }
    if (recording.userId !== userId) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only the recording's owner can remove it from the Organization",
            403,
        );
    }
}

/**
 * Delete the Organization view of a recording that is no longer shared.
 *
 * Its transcript, summary and speaker names were produced for the
 * organization; once the owner withdraws the recording nobody else may keep
 * reading them. Queued Organization jobs are cancelled with them.
 */
async function deleteOrgViewIfUnshared(
    tx: Tx,
    orgUserId: string,
    recordingId: string,
): Promise<void> {
    const remaining = await tx
        .select({ folderId: recordingFolderAssignments.folderId })
        .from(recordingFolderAssignments)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .where(
            and(
                eq(recordingFolderAssignments.recordingId, recordingId),
                eq(recordingFolders.userId, orgUserId),
            ),
        )
        .limit(1);
    if (remaining.length > 0) return;

    const now = new Date();
    await tx
        .update(recordings)
        .set({ unsharedAt: now })
        .where(eq(recordings.id, recordingId));
    await tx
        .delete(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.recordingId, recordingId),
                eq(aiEnhancements.userId, orgUserId),
            ),
        );
    await tx
        .delete(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, orgUserId),
            ),
        );
    await tx
        .update(asyncJobs)
        .set({
            status: "failed",
            completedAt: now,
            updatedAt: now,
            heartbeatAt: null,
            claimToken: null,
            errorCode: ErrorCode.RECORDING_NOT_FOUND,
            lastError: "Cancelled because the recording is no longer shared",
        })
        .where(
            and(
                eq(
                    asyncJobs.subjectId,
                    recordingJobSubject(recordingId, "org"),
                ),
                inArray(asyncJobs.status, ["pending", "processing"]),
            ),
        );
}

/**
 * Move a shared recording from one Organization folder to another.
 *
 * Open to every account: filing within the tree is collaborative, sharing
 * and unsharing are not. One transaction, so the recording is never briefly
 * unshared in between.
 */
export async function moveRecordingBetweenFolders(input: {
    userId: string;
    recordingId: string;
    fromFolderId: string;
    toFolderId: string;
}): Promise<void> {
    const orgUserId = await getOrgUserId();
    const [from, to] = await Promise.all([
        resolveFolder(db, input.userId, input.fromFolderId, orgUserId),
        resolveFolder(db, input.userId, input.toFolderId, orgUserId),
    ]);
    if (!from || !to || from.ownerId !== to.ownerId) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording or folder not found",
            404,
        );
    }
    if (to.folder.kind === "private") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Every recording already appears in Private",
            400,
        );
    }
    if (from.scope === "personal") {
        await requireOwnedRecording(db, input.userId, input.recordingId);
    }
    assertWritable(to);

    await db.transaction(async (tx) => {
        if (to.scope === "org") await lockOrgTree(tx);
        const [existing] = await tx
            .select({ userId: recordingFolderAssignments.userId })
            .from(recordingFolderAssignments)
            .where(
                and(
                    eq(
                        recordingFolderAssignments.recordingId,
                        input.recordingId,
                    ),
                    eq(recordingFolderAssignments.folderId, from.folder.id),
                ),
            )
            .limit(1);
        if (!existing) {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "Recording or folder not found",
                404,
            );
        }
        await tx
            .insert(recordingFolderAssignments)
            .values({
                userId: existing.userId,
                recordingId: input.recordingId,
                folderId: to.folder.id,
            })
            .onConflictDoNothing();
        await tx
            .delete(recordingFolderAssignments)
            .where(
                and(
                    eq(
                        recordingFolderAssignments.recordingId,
                        input.recordingId,
                    ),
                    eq(recordingFolderAssignments.folderId, from.folder.id),
                ),
            );
        await pruneRedundantAssignments(tx, to.ownerId, input.recordingId);
    });
    if (to.scope === "org") {
        await orgTreeChanged();
    } else {
        await scheduleExportProjection(input.userId);
    }
}

/**
 * Retire the per-user Public roots of a self-host instance.
 *
 * They were never shared with anyone. Empty ones are deleted; any with
 * content become a "Former Public" folder in their owner's Private tree, so
 * the upgrade shares nothing on its own. Idempotent.
 */
export async function retireLegacyPublicRoots(tx: Tx): Promise<number> {
    const legacyRoots = await tx
        .select(folderColumns)
        .from(recordingFolders)
        .innerJoin(users, eq(users.id, recordingFolders.userId))
        .where(
            and(
                eq(recordingFolders.kind, "public"),
                isNull(recordingFolders.parentId),
                ne(users.role, "org"),
            ),
        );
    let retired = 0;
    for (const root of legacyRoots) {
        const folders = await listTreeFolders(tx, root.userId);
        const subtree = [...subtreeIds(folders, root.id)];
        const [child] = folders.filter((folder) => folder.parentId === root.id);
        const [assignment] = await tx
            .select({ recordingId: recordingFolderAssignments.recordingId })
            .from(recordingFolderAssignments)
            .where(inArray(recordingFolderAssignments.folderId, subtree))
            .limit(1);
        if (!child && !assignment) {
            await tx
                .delete(recordingFolders)
                .where(eq(recordingFolders.id, root.id));
            retired += 1;
            continue;
        }

        await insertRoots(tx, root.userId, [PRIVATE_ROOT]);
        const [privateRoot] = await tx
            .select(folderColumns)
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, root.userId),
                    eq(recordingFolders.kind, "private"),
                    isNull(recordingFolders.parentId),
                ),
            )
            .limit(1);
        if (!privateRoot) continue;
        const siblings = folders.filter(
            (folder) => folder.parentId === privateRoot.id,
        );
        const takenNames = new Set(
            siblings.map((folder) => decryptText(folder.name)),
        );
        let name = "Former Public";
        for (let suffix = 2; takenNames.has(name); suffix += 1) {
            name = `Former Public ${suffix}`;
        }
        const sortOrder =
            siblings.reduce(
                (highest, sibling) => Math.max(highest, sibling.sortOrder),
                -FOLDER_ORDER_STEP,
            ) + FOLDER_ORDER_STEP;
        await tx
            .update(recordingFolders)
            .set({
                kind: "custom",
                parentId: privateRoot.id,
                name: encryptText(name),
                nameHash: lookupHash(name),
                sortOrder,
                updatedAt: new Date(),
            })
            .where(eq(recordingFolders.id, root.id));
        retired += 1;
    }
    return retired;
}
