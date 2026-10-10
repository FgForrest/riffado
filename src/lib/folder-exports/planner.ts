import { createHash } from "node:crypto";
import path from "node:path";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { audioItemColumns, recordingItemJoin } from "@/db/items";
import {
    aiEnhancements,
    chatterItems,
    filesystemExportNodes,
    filesystemExportSettings,
    folderExportDirectories,
    folderExportMaterializations,
    folderExportPlacements,
    recordings,
    transcriptions,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import {
    folderExportDocumentOptions,
    getRecordingMarkdownDocument,
} from "@/lib/export/document-sidecars";
import { listExportFolderOrganization } from "@/lib/folders/folders";
import {
    descendantFolderIds,
    exportPlacementFolderIds,
    relativeFolderChain,
} from "@/lib/folders/hierarchy";
import { isOrgAccount } from "@/lib/org/config";
import { sharedRecordingCondition } from "@/lib/sharing/shared";
import type { RecordingFolder } from "@/types/folder";
import { enqueueExportMaterialization } from "./jobs";
import { withExportLock } from "./lock";
import {
    allocateDirectoryName,
    audioExtension,
    documentFiles,
    folderDirectory,
    recordingDirectory,
    sourceFilename,
} from "./naming";
import { createExportProvider } from "./provider-factory";
import { clearExportFailure, recordExportFailure } from "./status";
import { type ExportTarget, loadExportTarget } from "./target";
import type {
    ExportArtifactType,
    ExportFormat,
    ExportProvider,
    OwnedEntryKind,
} from "./types";

interface PlannedArtifact {
    artifactType: ExportArtifactType;
    artifactId: string;
    format: ExportFormat;
    version: string;
    filename: string;
    size: number;
    /** Audio Riffado no longer holds: only an exported copy can stay. */
    reaped: boolean;
}

interface PathMove {
    previous: string;
    current: string;
}

interface ExistingState {
    id: string;
    recordingId: string;
    placementFolderId: string;
    artifactType: ExportArtifactType;
    artifactId: string;
    format: ExportFormat;
    artifactVersion: string;
    logicalPath: string;
    expectedSize: number;
    status: "pending" | "in_progress" | "exported" | "failed";
    exportedAt: Date | null;
}

interface PlannedState {
    id: string;
    status: ExistingState["status"];
    key: string;
    logicalPath: string;
    version: string;
    size: number;
    reaped: boolean;
}

/** A row left out of the plan whose file stays at `current`. */
interface KeptState {
    current: string;
    /** Restore it as written: a verified copy of reaped audio. */
    exported: boolean;
}

const BATCH = 500;

function digest(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function placementKey(recordingId: string, folderId: string): string {
    return `${recordingId}\0${folderId}`;
}

function artifactKey(state: {
    recordingId: string;
    artifactType: ExportArtifactType;
    artifactId: string;
    format: ExportFormat;
}): string {
    return [
        state.recordingId,
        state.artifactType,
        state.artifactId,
        state.format,
    ].join("\0");
}

function relocatedPath(value: string, moves: PathMove[]): string {
    let current = value;
    for (const move of moves) {
        if (current === move.previous) {
            current = move.current;
        } else if (current.startsWith(`${move.previous}/`)) {
            current = `${move.current}${current.slice(move.previous.length)}`;
        }
    }
    return current;
}

function allocationPriority(
    existingName: string | undefined,
    preferredName: string,
): number {
    if (existingName === preferredName) return 0;
    if (existingName) return 1;
    return 2;
}

function pathPrefixes(logicalPath: string): string[] {
    const parts = logicalPath.split("/");
    return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function legacyProjectionPaths(
    targetPath: string,
    configurationFolderId: string,
    folders: RecordingFolder[],
    states: Array<{
        recordingId: string;
        placementFolderId: string;
        logicalPath: string;
    }>,
): {
    directories: Map<string, string>;
    placements: Map<string, string>;
} {
    const directories = new Map<string, string>();
    const placements = new Map<string, string>();
    const targetParts = targetPath.split("/");

    for (const state of states) {
        const chain = relativeFolderChain(
            folders,
            configurationFolderId,
            state.placementFolderId,
        );
        if (!chain) continue;
        const placementPath = path.posix.dirname(state.logicalPath);
        const parts = placementPath.split("/");
        const expectedLength = targetParts.length + chain.length + 1;
        if (
            parts.length !== expectedLength ||
            !targetParts.every((part, index) => parts[index] === part)
        ) {
            continue;
        }

        chain.forEach((folder, index) => {
            directories.set(
                folder.id,
                parts.slice(0, targetParts.length + index + 1).join("/"),
            );
        });
        placements.set(
            placementKey(state.recordingId, state.placementFolderId),
            placementPath,
        );
    }
    return { directories, placements };
}

/**
 * Projects the export's folder subtree onto its target: one directory per
 * folder, one per placement of a recording, and the files of each.
 *
 * Whatever the export wrote earlier and no longer places is moved where it
 * belongs now or deleted; entries it did not create are never touched.
 * With `verify`, entries someone removed from the target are forgotten
 * first, so they are written again.
 */
export async function planFolderExport(
    userId: string,
    exportId: string,
    options: { verify?: boolean } = {},
): Promise<number> {
    let queued: number;
    try {
        // Exclusive: it moves directories and every stored path under them.
        queued = await withExportLock(exportId, "exclusive", () =>
            planLocked(userId, exportId, options.verify ?? false),
        );
    } catch (error) {
        await recordExportFailure(userId, exportId, error).catch(() => {});
        throw error;
    }
    await clearExportFailure(userId, exportId);
    return queued;
}

async function planLocked(
    userId: string,
    exportId: string,
    verify: boolean,
): Promise<number> {
    const configuration = await loadExportTarget(userId, exportId);
    if (!configuration) return 0;

    // The organization account exports every shared recording: the
    // owner's rows and audio, as a shared recording is one recording.
    // Everyone else exports their own library.
    const isOrg = await isOrgAccount(userId);
    const organization = await listExportFolderOrganization(userId);
    const configSubtree = descendantFolderIds(
        organization.folders,
        configuration.folderId,
    );
    const recordingRows = await db
        .select(audioItemColumns)
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                isOrg
                    ? sharedRecordingCondition(userId)
                    : eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        );
    // The Organization's rows: those the owner of a shared recording holds.
    const sharedContent = and(
        sharedRecordingCondition(userId),
        isNull(recordings.deletedAt),
    );
    const [
        transcriptRows,
        summaryRows,
        existingStates,
        existingDirectories,
        existingPlacements,
    ] = await Promise.all([
        db
            .select({
                id: transcriptions.id,
                recordingId: transcriptions.recordingId,
                source: transcriptions.source,
                userId: transcriptions.userId,
            })
            .from(transcriptions)
            .innerJoin(
                recordings,
                and(
                    eq(recordings.id, transcriptions.recordingId),
                    eq(recordings.userId, transcriptions.userId),
                ),
            )
            .where(isOrg ? sharedContent : eq(transcriptions.userId, userId)),
        db
            .select({
                id: aiEnhancements.id,
                recordingId: aiEnhancements.itemId,
                source: aiEnhancements.source,
                userId: aiEnhancements.userId,
            })
            .from(aiEnhancements)
            .innerJoin(
                recordings,
                and(
                    eq(recordings.id, aiEnhancements.itemId),
                    eq(recordings.userId, aiEnhancements.userId),
                ),
            )
            .where(isOrg ? sharedContent : eq(aiEnhancements.userId, userId)),
        db
            .select({
                id: folderExportMaterializations.id,
                recordingId: folderExportMaterializations.itemId,
                placementFolderId:
                    folderExportMaterializations.placementFolderId,
                artifactType: folderExportMaterializations.artifactType,
                artifactId: folderExportMaterializations.artifactId,
                format: folderExportMaterializations.format,
                artifactVersion: folderExportMaterializations.artifactVersion,
                logicalPath: folderExportMaterializations.logicalPath,
                expectedSize: folderExportMaterializations.expectedSize,
                status: folderExportMaterializations.status,
                exportedAt: folderExportMaterializations.exportedAt,
            })
            .from(folderExportMaterializations)
            .where(
                and(
                    eq(folderExportMaterializations.userId, userId),
                    eq(
                        folderExportMaterializations.exportConfigurationId,
                        exportId,
                    ),
                ),
            ),
        db
            .select()
            .from(folderExportDirectories)
            .where(
                and(
                    eq(folderExportDirectories.userId, userId),
                    eq(folderExportDirectories.exportConfigurationId, exportId),
                ),
            ),
        db
            .select()
            .from(folderExportPlacements)
            .where(
                and(
                    eq(folderExportPlacements.userId, userId),
                    eq(folderExportPlacements.exportConfigurationId, exportId),
                ),
            ),
    ]);
    const provider = await createExportProvider(configuration);
    if (
        configuration.provider === "filesystem" &&
        !configuration.nodesAdoptedAt
    ) {
        await adoptLegacyEntries(
            userId,
            configuration,
            provider,
            existingStates,
            [...existingDirectories, ...existingPlacements],
        );
    }
    if (verify) await provider.forgetMissing();
    await provider.reconcileDirectory(null, configuration.targetPath);
    await Promise.all([
        db
            .update(folderExportDirectories)
            .set({ expected: false, updatedAt: new Date() })
            .where(
                and(
                    eq(folderExportDirectories.userId, userId),
                    eq(folderExportDirectories.exportConfigurationId, exportId),
                ),
            ),
        db
            .update(folderExportPlacements)
            .set({ expected: false, updatedAt: new Date() })
            .where(
                and(
                    eq(folderExportPlacements.userId, userId),
                    eq(folderExportPlacements.exportConfigurationId, exportId),
                ),
            ),
    ]);

    const legacy = legacyProjectionPaths(
        configuration.targetPath,
        configuration.folderId,
        organization.folders,
        existingStates,
    );
    const directoryByFolder = new Map(
        existingDirectories.map((directory) => [directory.folderId, directory]),
    );
    const placementByKey = new Map(
        existingPlacements.map((placement) => [
            placementKey(placement.itemId, placement.placementFolderId),
            placement,
        ]),
    );
    const folderPathById = new Map<string, string>([
        [configuration.folderId, configuration.targetPath],
    ]);
    const moves: PathMove[] = [];
    const childrenByParent = new Map<string, RecordingFolder[]>();
    for (const folder of organization.folders) {
        if (
            folder.id === configuration.folderId ||
            !configSubtree.has(folder.id) ||
            !folder.parentId
        ) {
            continue;
        }
        const children = childrenByParent.get(folder.parentId) ?? [];
        children.push(folder);
        childrenByParent.set(folder.parentId, children);
    }

    const parentQueue = [configuration.folderId];
    while (parentQueue.length > 0) {
        const parentId = parentQueue.shift();
        if (!parentId) continue;
        const parentPath = folderPathById.get(parentId);
        if (!parentPath) continue;
        const children = childrenByParent.get(parentId) ?? [];
        children.sort((left, right) => {
            const leftPreferred = folderDirectory(left.name);
            const rightPreferred = folderDirectory(right.name);
            const priority =
                allocationPriority(
                    directoryByFolder.get(left.id)?.directoryName,
                    leftPreferred,
                ) -
                allocationPriority(
                    directoryByFolder.get(right.id)?.directoryName,
                    rightPreferred,
                );
            return priority || left.id.localeCompare(right.id);
        });
        const taken =
            children.length > 0
                ? await provider.takenNames(parentPath)
                : { names: new Set<string>(), foreign: new Set<string>() };
        // A folder may take over a directory the export is vacating: the
        // recordings placed in it then avoid every name already there.
        const occupied = new Set([
            ...taken.foreign,
            ...children.flatMap((folder) => {
                const existing = directoryByFolder.get(folder.id);
                return existing?.targetPath === configuration.targetPath
                    ? [existing.directoryName]
                    : [];
            }),
        ]);
        for (const folder of children) {
            const existing = directoryByFolder.get(folder.id);
            if (
                existing?.targetPath === configuration.targetPath &&
                !taken.foreign.has(existing.directoryName)
            ) {
                occupied.delete(existing.directoryName);
            }
            const directoryName = allocateDirectoryName(
                folderDirectory(folder.name),
                occupied,
            );
            occupied.add(directoryName);
            const logicalPath = path.posix.join(parentPath, directoryName);
            const sameTarget =
                existing?.targetPath === configuration.targetPath;
            const storedPrevious = sameTarget
                ? existing.logicalPath
                : existing
                  ? null
                  : (legacy.directories.get(folder.id) ?? null);
            const previousPath = storedPrevious
                ? relocatedPath(storedPrevious, moves)
                : null;
            const reconciliation = await provider.reconcileDirectory(
                previousPath,
                logicalPath,
            );
            if (
                (sameTarget || !existing) &&
                reconciliation.contentPreserved &&
                previousPath &&
                previousPath !== logicalPath
            ) {
                moves.push({ previous: previousPath, current: logicalPath });
            }
            await db
                .insert(folderExportDirectories)
                .values({
                    userId,
                    exportConfigurationId: exportId,
                    folderId: folder.id,
                    targetPath: configuration.targetPath,
                    directoryName,
                    logicalPath,
                    expected: true,
                })
                .onConflictDoUpdate({
                    target: [
                        folderExportDirectories.exportConfigurationId,
                        folderExportDirectories.folderId,
                    ],
                    set: {
                        targetPath: configuration.targetPath,
                        directoryName,
                        logicalPath,
                        expected: true,
                        updatedAt: new Date(),
                    },
                });
            folderPathById.set(folder.id, logicalPath);
            parentQueue.push(folder.id);
        }
    }

    const exportedAudio = new Map<string, ExistingState>();
    for (const state of existingStates) {
        if (
            state.artifactType === "audio" &&
            state.status === "exported" &&
            !exportedAudio.has(state.recordingId)
        ) {
            exportedAudio.set(state.recordingId, state);
        }
    }

    const plannedPlacements: Array<{
        recording: (typeof recordingRows)[number];
        placementFolderId: string;
        artifacts: PlannedArtifact[];
        preferredName: string;
    }> = [];
    const placementFoldersByRecording = new Map<string, Set<string>>();
    for (const recording of recordingRows) {
        const placements = exportPlacementFolderIds(
            organization.folders,
            organization.assignments,
            recording.id,
            configuration.folderId,
        ).filter((folderId) => configSubtree.has(folderId));
        if (placements.length === 0) continue;
        placementFoldersByRecording.set(recording.id, new Set(placements));

        const artifacts: PlannedArtifact[] = [];
        const filename = `audio${audioExtension(
            recording.storageFilename ?? recording.storagePath,
        )}`;
        if (configuration.exportAudio && !recording.audioReapedAt) {
            artifacts.push({
                artifactType: "audio",
                artifactId: recording.id,
                format: "file",
                version: digest(
                    [
                        recording.fileMd5,
                        recording.plaudVersion,
                        recording.storagePath,
                        recording.filesize,
                    ].join(":"),
                ),
                filename,
                size: recording.filesize,
                reaped: false,
            });
        } else if (configuration.exportAudio) {
            const kept = exportedAudio.get(recording.id);
            if (kept) {
                artifacts.push({
                    artifactType: "audio",
                    artifactId: recording.id,
                    format: "file",
                    version: kept.artifactVersion,
                    filename: path.posix.basename(kept.logicalPath),
                    size: kept.expectedSize,
                    reaped: true,
                });
            }
        }
        if (configuration.exportTranscript) {
            for (const transcript of transcriptRows.filter(
                (row) => row.recordingId === recording.id,
            )) {
                const document = await getRecordingMarkdownDocument(
                    transcript.userId,
                    recording.id,
                    "transcript",
                    folderExportDocumentOptions(transcript.source, isOrg),
                );
                if (!document) continue;
                const content = Buffer.from(document.content);
                for (const file of documentFiles(
                    configuration.googleDrive?.transcriptFormat ?? "markdown",
                    sourceFilename(transcript.source, "transcript"),
                )) {
                    artifacts.push({
                        artifactType: "transcript",
                        artifactId: transcript.id,
                        format: file.format,
                        version: digest(content),
                        filename: file.filename,
                        size: content.byteLength,
                        reaped: false,
                    });
                }
            }
        }
        if (configuration.exportSummary) {
            for (const summary of summaryRows.filter(
                (row) => row.recordingId === recording.id,
            )) {
                const document = await getRecordingMarkdownDocument(
                    summary.userId,
                    recording.id,
                    "summary",
                    folderExportDocumentOptions(summary.source, isOrg),
                );
                if (!document) continue;
                const content = Buffer.from(document.content);
                for (const file of documentFiles(
                    configuration.googleDrive?.summaryFormat ?? "markdown",
                    sourceFilename(summary.source, "summary"),
                )) {
                    artifacts.push({
                        artifactType: "summary",
                        artifactId: summary.id,
                        format: file.format,
                        version: digest(content),
                        filename: file.filename,
                        size: content.byteLength,
                        reaped: false,
                    });
                }
            }
        }
        for (const placementFolderId of placements) {
            plannedPlacements.push({
                recording,
                placementFolderId,
                artifacts,
                preferredName: recordingDirectory(decryptText(recording.title)),
            });
        }
    }

    // A placement the recording left, matched with one it gained: the
    // recording moved between folders, so its directory moves with it.
    const movedFrom = new Map<string, (typeof existingPlacements)[number]>();
    for (const [recordingId, folderIds] of placementFoldersByRecording) {
        const left = existingPlacements
            .filter(
                (placement) =>
                    placement.itemId === recordingId &&
                    placement.targetPath === configuration.targetPath &&
                    !folderIds.has(placement.placementFolderId),
            )
            .sort(
                (a, b) =>
                    Number(b.expected) - Number(a.expected) ||
                    b.updatedAt.getTime() - a.updatedAt.getTime() ||
                    a.id.localeCompare(b.id),
            );
        const gained = [...folderIds]
            .filter(
                (folderId) =>
                    !placementByKey.has(placementKey(recordingId, folderId)),
            )
            .sort();
        for (const folderId of gained) {
            const from = left.shift();
            if (!from) break;
            movedFrom.set(placementKey(recordingId, folderId), from);
        }
    }

    plannedPlacements.sort((left, right) => {
        const folderOrder = left.placementFolderId.localeCompare(
            right.placementFolderId,
        );
        if (folderOrder) return folderOrder;
        const leftExisting = placementByKey.get(
            placementKey(left.recording.id, left.placementFolderId),
        );
        const rightExisting = placementByKey.get(
            placementKey(right.recording.id, right.placementFolderId),
        );
        const priority =
            allocationPriority(
                leftExisting?.directoryName,
                left.preferredName,
            ) -
            allocationPriority(
                rightExisting?.directoryName,
                right.preferredName,
            );
        return priority || left.recording.id.localeCompare(right.recording.id);
    });

    // Every name in a directory is taken, the export's own included: a
    // directory the plan is about to vacate still holds what it wrote.
    const occupiedByFolder = new Map<string, Set<string>>();
    const foreignByFolder = new Map<string, Set<string>>();
    for (const placement of plannedPlacements) {
        const parentPath = folderPathById.get(placement.placementFolderId);
        if (!parentPath || foreignByFolder.has(placement.placementFolderId)) {
            continue;
        }
        const taken = await provider.takenNames(parentPath);
        foreignByFolder.set(placement.placementFolderId, taken.foreign);
        occupiedByFolder.set(placement.placementFolderId, new Set(taken.names));
    }
    for (const placement of plannedPlacements) {
        const existing = placementByKey.get(
            placementKey(placement.recording.id, placement.placementFolderId),
        );
        if (existing?.targetPath !== configuration.targetPath) continue;
        occupiedByFolder
            .get(placement.placementFolderId)
            ?.add(existing.directoryName);
    }
    const plannedStates: PlannedState[] = [];
    const plannedPlacementPaths = new Set<string>();
    for (const placement of plannedPlacements) {
        const parentPath = folderPathById.get(placement.placementFolderId);
        if (!parentPath) continue;
        const occupied =
            occupiedByFolder.get(placement.placementFolderId) ??
            new Set<string>();
        const foreign =
            foreignByFolder.get(placement.placementFolderId) ??
            new Set<string>();
        const key = placementKey(
            placement.recording.id,
            placement.placementFolderId,
        );
        const existing = placementByKey.get(key);
        const sameTarget = existing?.targetPath === configuration.targetPath;
        if (sameTarget && !foreign.has(existing.directoryName)) {
            occupied.delete(existing.directoryName);
        }
        const directoryName = allocateDirectoryName(
            placement.preferredName,
            occupied,
        );
        occupied.add(directoryName);
        const logicalDirectoryPath = path.posix.join(parentPath, directoryName);
        plannedPlacementPaths.add(logicalDirectoryPath);
        const storedPrevious = sameTarget
            ? existing.logicalPath
            : existing
              ? null
              : (movedFrom.get(key)?.logicalPath ??
                legacy.placements.get(key) ??
                null);
        const previousPath = storedPrevious
            ? relocatedPath(storedPrevious, moves)
            : null;
        const reconciliation = await provider.reconcileDirectory(
            previousPath,
            logicalDirectoryPath,
        );
        if (
            reconciliation.contentPreserved &&
            previousPath &&
            previousPath !== logicalDirectoryPath
        ) {
            moves.push({
                previous: previousPath,
                current: logicalDirectoryPath,
            });
        }
        const contentPreserved =
            (sameTarget || legacy.placements.has(key)) &&
            reconciliation.contentPreserved;
        await db
            .insert(folderExportPlacements)
            .values({
                userId,
                exportConfigurationId: exportId,
                itemId: placement.recording.id,
                placementFolderId: placement.placementFolderId,
                targetPath: configuration.targetPath,
                directoryName,
                logicalPath: logicalDirectoryPath,
                expected: true,
            })
            .onConflictDoUpdate({
                target: [
                    folderExportPlacements.exportConfigurationId,
                    folderExportPlacements.itemId,
                    folderExportPlacements.placementFolderId,
                ],
                set: {
                    targetPath: configuration.targetPath,
                    directoryName,
                    logicalPath: logicalDirectoryPath,
                    expected: true,
                    updatedAt: new Date(),
                },
            });

        for (const artifact of placement.artifacts) {
            const logicalPath = path.posix.join(
                logicalDirectoryPath,
                artifact.filename,
            );
            const [state] = await db
                .insert(folderExportMaterializations)
                .values({
                    userId,
                    exportConfigurationId: exportId,
                    itemId: placement.recording.id,
                    placementFolderId: placement.placementFolderId,
                    artifactType: artifact.artifactType,
                    artifactId: artifact.artifactId,
                    format: artifact.format,
                    artifactVersion: artifact.version,
                    logicalPath,
                    expectedSize: artifact.size,
                    expected: true,
                    status: "pending",
                })
                .onConflictDoUpdate({
                    target: [
                        folderExportMaterializations.exportConfigurationId,
                        folderExportMaterializations.placementFolderId,
                        folderExportMaterializations.artifactType,
                        folderExportMaterializations.artifactId,
                        folderExportMaterializations.format,
                    ],
                    set: {
                        artifactVersion: artifact.version,
                        logicalPath,
                        expectedSize: artifact.size,
                        expected: true,
                        status: sql`case when ${folderExportMaterializations.artifactVersion} <> ${artifact.version} or ${folderExportMaterializations.expectedSize} <> ${artifact.size} or not ${folderExportMaterializations.expected} or not ${contentPreserved} then 'pending' else ${folderExportMaterializations.status} end`,
                        updatedAt: new Date(),
                    },
                })
                .returning({
                    id: folderExportMaterializations.id,
                    status: folderExportMaterializations.status,
                });
            if (!state) continue;
            plannedStates.push({
                id: state.id,
                status: state.status,
                key: artifactKey({
                    recordingId: placement.recording.id,
                    ...artifact,
                }),
                logicalPath,
                version: artifact.version,
                size: artifact.size,
                reaped: artifact.reaped,
            });
        }
    }

    const plannedIds = new Set(plannedStates.map((state) => state.id));
    const plannedFilePaths = new Set(
        plannedStates.map((state) => state.logicalPath),
    );
    const plannedKeys = new Set(plannedStates.map((state) => state.key));
    const consumed = new Set<string>();
    const statesByKey = new Map<string, ExistingState[]>();
    for (const state of existingStates) {
        const key = artifactKey(state);
        const list = statesByKey.get(key) ?? [];
        list.push(state);
        statesByKey.set(key, list);
    }

    let queued = 0;
    const unproducible: string[] = [];
    const placedKeys = new Set<string>();
    const keptStates = new Map<string, KeptState>();
    for (const planned of plannedStates) {
        if (planned.status !== "pending" && planned.status !== "failed") {
            if (planned.status === "exported") placedKeys.add(planned.key);
            continue;
        }
        const candidates = (statesByKey.get(planned.key) ?? []).filter(
            (state) =>
                !consumed.has(state.id) &&
                (state.id === planned.id || !plannedIds.has(state.id)),
        );
        const inPlace = await reuseWrittenCopy(
            provider,
            planned,
            candidates,
            moves,
            consumed,
        );
        if (inPlace) placedKeys.add(planned.key);
        if (inPlace) {
            await db
                .update(folderExportMaterializations)
                .set({
                    status: "exported",
                    lastError: null,
                    exportedAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(folderExportMaterializations.id, planned.id),
                        eq(folderExportMaterializations.userId, userId),
                    ),
                );
        } else if (planned.reaped) {
            // Riffado no longer holds this audio: a copy that could not be
            // moved stays where it is, the only one left.
            for (const state of candidates) {
                const current = relocatedPath(state.logicalPath, moves);
                if (
                    state.status === "exported" &&
                    (await provider.exists(current, {
                        size: state.expectedSize,
                        version: state.artifactVersion,
                        format: state.format,
                    }))
                ) {
                    keptStates.set(state.id, { current, exported: true });
                }
            }
            if (!keptStates.has(planned.id)) unproducible.push(planned.id);
        } else {
            await enqueueExportMaterialization(userId, planned.id);
            queued += 1;
        }
    }

    const staleStates = existingStates.filter(
        (state) => !plannedIds.has(state.id),
    );
    for (const state of staleStates) {
        if (consumed.has(state.id) || keptStates.has(state.id)) continue;
        const current = relocatedPath(state.logicalPath, moves);
        if (plannedFilePaths.has(current)) continue;
        const key = artifactKey(state);
        const removed = await provider
            .removeFile(current, { duplicate: placedKeys.has(key) })
            .catch((error) => {
                console.error(
                    `[folder-export] could not remove ${current}:`,
                    error,
                );
                return false;
            });
        // Its counterpart is not written yet: decide on the next plan.
        if (!removed && plannedKeys.has(key) && !placedKeys.has(key)) {
            keptStates.set(state.id, { current, exported: false });
        }
    }
    await keepStates(userId, exportId, keptStates);
    await deleteStates(userId, exportId, [
        ...staleStates
            .map((state) => state.id)
            .filter((id) => !keptStates.has(id)),
        ...unproducible,
    ]);

    const plannedDirectories = new Set([
        ...pathPrefixes(configuration.targetPath),
        ...folderPathById.values(),
        ...plannedPlacementPaths,
    ]);
    await removeUnplannedEntries(
        provider,
        await provider.ownedEntries(),
        new Set([
            ...plannedFilePaths,
            ...[...keptStates.values()].map((kept) => kept.current),
        ]),
        plannedDirectories,
    );
    await Promise.all([
        db
            .delete(folderExportDirectories)
            .where(
                and(
                    eq(folderExportDirectories.userId, userId),
                    eq(folderExportDirectories.exportConfigurationId, exportId),
                    eq(folderExportDirectories.expected, false),
                ),
            ),
        db
            .delete(folderExportPlacements)
            .where(
                and(
                    eq(folderExportPlacements.userId, userId),
                    eq(folderExportPlacements.exportConfigurationId, exportId),
                    eq(folderExportPlacements.expected, false),
                ),
            ),
    ]);
    return queued;
}

/**
 * Takes the entries the export wrote before it tracked what it creates:
 * files it recorded as written and the directories of its folders and
 * placements, stale ones included, so the plan can clean them up.
 */
async function adoptLegacyEntries(
    userId: string,
    configuration: ExportTarget,
    provider: ExportProvider,
    states: ExistingState[],
    directories: Array<{ logicalPath: string }>,
): Promise<void> {
    const entries = new Map<string, OwnedEntryKind>();
    for (const directory of directories) {
        entries.set(directory.logicalPath, "directory");
    }
    for (const state of states) {
        if (state.exportedAt) entries.set(state.logicalPath, "file");
    }
    // Another export of the same tree may have taken them first.
    const paths = [...entries.keys()];
    for (let offset = 0; offset < paths.length; offset += BATCH) {
        const claimed = await db
            .select({ logicalPath: filesystemExportNodes.logicalPath })
            .from(filesystemExportNodes)
            .where(
                and(
                    eq(filesystemExportNodes.userId, userId),
                    ne(
                        filesystemExportNodes.exportConfigurationId,
                        configuration.id,
                    ),
                    inArray(
                        filesystemExportNodes.logicalPath,
                        paths.slice(offset, offset + BATCH),
                    ),
                ),
            );
        for (const row of claimed) entries.delete(row.logicalPath);
    }
    await provider.adopt(entries);
    await db
        .update(filesystemExportSettings)
        .set({ nodesAdoptedAt: new Date(), updatedAt: new Date() })
        .where(
            and(
                eq(
                    filesystemExportSettings.exportConfigurationId,
                    configuration.id,
                ),
                eq(filesystemExportSettings.userId, userId),
            ),
        );
}

/**
 * Puts a copy the export already wrote of the planned artifact at its
 * planned path, moving it there when it is elsewhere. True when that copy
 * is the planned version, so nothing has to be written.
 */
async function reuseWrittenCopy(
    provider: ExportProvider,
    planned: PlannedState,
    candidates: ExistingState[],
    moves: PathMove[],
    consumed: Set<string>,
): Promise<boolean> {
    const located = candidates
        .filter((state) => state.status === "exported" && state.exportedAt)
        .map((state) => ({
            state,
            current: relocatedPath(state.logicalPath, moves),
            sameVersion:
                state.artifactVersion === planned.version &&
                state.expectedSize === planned.size,
        }))
        .sort(
            (left, right) =>
                Number(right.current === planned.logicalPath) -
                    Number(left.current === planned.logicalPath) ||
                Number(right.sameVersion) - Number(left.sameVersion),
        );
    for (const { state, current, sameVersion } of located) {
        const written = await provider.exists(current, {
            size: state.expectedSize,
            version: state.artifactVersion,
            format: state.format,
        });
        if (!written) continue;
        if (current !== planned.logicalPath) {
            if (!(await provider.moveFile(current, planned.logicalPath))) {
                continue;
            }
        }
        if (state.id !== planned.id) consumed.add(state.id);
        return sameVersion;
    }
    return false;
}

/**
 * Removes what the export created and no longer places: files first, then
 * directories deepest first, each only while empty, so anything someone
 * put there keeps its directory.
 */
async function removeUnplannedEntries(
    provider: ExportProvider,
    owned: ReadonlyMap<string, OwnedEntryKind>,
    plannedFiles: ReadonlySet<string>,
    plannedDirectories: ReadonlySet<string>,
): Promise<void> {
    const report = (entry: string) => (error: unknown) => {
        console.error(`[folder-export] could not remove ${entry}:`, error);
    };
    for (const [entry, kind] of owned) {
        if (kind !== "file" || plannedFiles.has(entry)) continue;
        await provider
            .removeFile(entry, { duplicate: false })
            .catch(report(entry));
    }
    const directories = [...owned]
        .filter(
            ([entry, kind]) =>
                kind === "directory" && !plannedDirectories.has(entry),
        )
        .map(([entry]) => entry)
        .sort(
            (left, right) =>
                right.split("/").length - left.split("/").length ||
                left.localeCompare(right),
        );
    for (const directory of directories) {
        await provider.removeEmptyDirectory(directory).catch(report(directory));
    }
}

/**
 * Leaves rows whose file stays where it is out of the plan, at the path
 * the file is at now, for the next plan to place.
 */
async function keepStates(
    userId: string,
    exportId: string,
    kept: ReadonlyMap<string, KeptState>,
): Promise<void> {
    for (const [id, { current, exported }] of kept) {
        await db
            .update(folderExportMaterializations)
            .set({
                logicalPath: current,
                ...(exported ? { status: "exported" as const } : {}),
                expected: false,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(folderExportMaterializations.id, id),
                    eq(folderExportMaterializations.userId, userId),
                    eq(
                        folderExportMaterializations.exportConfigurationId,
                        exportId,
                    ),
                ),
            );
    }
}

async function deleteStates(
    userId: string,
    exportId: string,
    ids: string[],
): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += BATCH) {
        await db
            .delete(folderExportMaterializations)
            .where(
                and(
                    eq(folderExportMaterializations.userId, userId),
                    eq(
                        folderExportMaterializations.exportConfigurationId,
                        exportId,
                    ),
                    inArray(
                        folderExportMaterializations.id,
                        ids.slice(offset, offset + BATCH),
                    ),
                ),
            );
    }
}
