import type {
    FolderOrganization,
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";

export function organizationForDeployment(
    organization: FolderOrganization,
    options: { isHosted: boolean; selfHostMode: "local" | "shared" },
): FolderOrganization {
    if (options.isHosted || options.selfHostMode === "shared") {
        return organization;
    }
    const publicRoot = organization.folders.find(
        (folder) => folder.kind === "public",
    );
    if (!publicRoot) return organization;
    const hiddenIds = descendantFolderIds(organization.folders, publicRoot.id);
    return {
        folders: organization.folders.filter(
            (folder) => !hiddenIds.has(folder.id),
        ),
        assignments: organization.assignments.filter(
            (assignment) => !hiddenIds.has(assignment.folderId),
        ),
    };
}

export function descendantFolderIds(
    folders: ReadonlyArray<Pick<RecordingFolder, "id" | "parentId">>,
    folderId: string,
): Set<string> {
    const children = new Map<string, string[]>();
    for (const folder of folders) {
        if (!folder.parentId) continue;
        const ids = children.get(folder.parentId) ?? [];
        ids.push(folder.id);
        children.set(folder.parentId, ids);
    }

    const result = new Set<string>();
    const pending = [folderId];
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current || result.has(current)) continue;
        result.add(current);
        pending.push(...(children.get(current) ?? []));
    }
    return result;
}

export function ancestorFolderIds(
    folders: ReadonlyArray<Pick<RecordingFolder, "id" | "parentId">>,
    folderId: string,
): Set<string> {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const result = new Set<string>();
    let current = byId.get(folderId);
    while (current) {
        if (result.has(current.id)) break;
        result.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return result;
}

/**
 * Recordings shown in a folder. The Private root lists every recording the
 * viewer owns, `privateRecordingIds` -- never the Organization's recordings
 * of other people, which `allRecordingIds` may also carry.
 */
export function recordingIdsVisibleInFolder(
    folders: RecordingFolder[],
    assignments: RecordingFolderAssignment[],
    folder: RecordingFolder,
    privateRecordingIds: Iterable<string>,
): Set<string> {
    if (folder.kind === "private") return new Set(privateRecordingIds);
    const subtree = descendantFolderIds(folders, folder.id);
    return new Set(
        assignments.flatMap((assignment) =>
            subtree.has(assignment.folderId) ? [assignment.recordingId] : [],
        ),
    );
}

export function effectiveRecordingCounts(
    folders: RecordingFolder[],
    assignments: RecordingFolderAssignment[],
    allRecordingIds: Iterable<string>,
    privateRecordingIds: Iterable<string> = allRecordingIds,
): Map<string, number> {
    const recordingIds = new Set(allRecordingIds);
    const privateIds = new Set(privateRecordingIds);
    return new Map(
        folders.map((folder) => [
            folder.id,
            recordingIdsVisibleInFolder(
                folders,
                assignments.filter((assignment) =>
                    recordingIds.has(assignment.recordingId),
                ),
                folder,
                privateIds,
            ).size,
        ]),
    );
}

export function canonicalFolderIds(
    folders: RecordingFolder[],
    folderIds: Iterable<string>,
): Set<string> {
    const selected = new Set(folderIds);
    const result = new Set(selected);
    for (const folderId of selected) {
        const ancestors = ancestorFolderIds(folders, folderId);
        ancestors.delete(folderId);
        for (const ancestorId of ancestors) result.delete(ancestorId);
    }
    return result;
}

export function applicableExportConfigurationIds(
    folders: ReadonlyArray<Pick<RecordingFolder, "id" | "parentId">>,
    selectedFolderId: string,
    configurations: ReadonlyArray<{ id: string; folderId: string }>,
): string[] {
    const ancestors = ancestorFolderIds(folders, selectedFolderId);
    return configurations
        .filter((configuration) => ancestors.has(configuration.folderId))
        .map((configuration) => configuration.id);
}

export function exportPlacementFolderIds(
    folders: RecordingFolder[],
    assignments: RecordingFolderAssignment[],
    recordingId: string,
    exportFolderId: string,
): string[] {
    const exportSubtree = descendantFolderIds(folders, exportFolderId);
    const direct = assignments
        .filter((assignment) => assignment.recordingId === recordingId)
        .map((assignment) => assignment.folderId);
    const placements = [...canonicalFolderIds(folders, direct)].filter(
        (folderId) => exportSubtree.has(folderId),
    );
    if (placements.length > 0) return placements;

    const privateRoot = folders.find((folder) => folder.kind === "private");
    if (!privateRoot || privateRoot.id !== exportFolderId) return [];
    const privateSubtree = descendantFolderIds(folders, privateRoot.id);
    return direct.some((folderId) => privateSubtree.has(folderId))
        ? []
        : [privateRoot.id];
}

export function relativeFolderPath(
    folders: RecordingFolder[],
    rootFolderId: string,
    placementFolderId: string,
): string[] | null {
    return (
        relativeFolderChain(folders, rootFolderId, placementFolderId)?.map(
            (folder) => folder.name,
        ) ?? null
    );
}

export function relativeFolderChain(
    folders: RecordingFolder[],
    rootFolderId: string,
    placementFolderId: string,
): RecordingFolder[] | null {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const segments: RecordingFolder[] = [];
    let current = byId.get(placementFolderId);
    while (current && current.id !== rootFolderId) {
        segments.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return current?.id === rootFolderId ? segments : null;
}
