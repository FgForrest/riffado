import { createHash } from "node:crypto";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    folderExportDirectories,
    folderExportMaterializations,
    folderExportPlacements,
    recordings,
    transcriptions,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { getRecordingMarkdownDocument } from "@/lib/export/document-sidecars";
import { listExportFolderOrganization } from "@/lib/folders/folders";
import {
    descendantFolderIds,
    exportPlacementFolderIds,
    relativeFolderChain,
} from "@/lib/folders/hierarchy";
import { isOrgAccount } from "@/lib/org/config";
import { sharedRecordingCondition } from "@/lib/sharing/shared";
import {
    readOrgViewSummaryRows,
    readOrgViewTranscriptRows,
} from "@/lib/sharing/view-content";
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
import { loadExportTarget } from "./target";
import type { ExportArtifactType, ExportFormat, ExportProvider } from "./types";

interface PlannedArtifact {
    artifactType: ExportArtifactType;
    artifactId: string;
    format: ExportFormat;
    version: string;
    filename: string;
    size: number;
}

interface PathMove {
    previous: string;
    current: string;
}

function digest(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function placementKey(recordingId: string, folderId: string): string {
    return `${recordingId}\0${folderId}`;
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

export async function planFolderExport(
    userId: string,
    exportId: string,
): Promise<number> {
    let queued: number;
    try {
        // Exclusive: it moves directories and every stored path under them.
        queued = await withExportLock(exportId, "exclusive", () =>
            planLocked(userId, exportId),
        );
    } catch (error) {
        await recordExportFailure(userId, exportId, error).catch(() => {});
        throw error;
    }
    await clearExportFailure(userId, exportId);
    return queued;
}

async function planLocked(userId: string, exportId: string): Promise<number> {
    const configuration = await loadExportTarget(userId, exportId);
    if (!configuration) return 0;

    // The organization account exports the Organization view of every
    // shared recording: its own rows, else the owner's, under the owner's
    // audio. Everyone else exports their own library.
    const isOrg = await isOrgAccount(userId);
    const organization = await listExportFolderOrganization(userId);
    const configSubtree = descendantFolderIds(
        organization.folders,
        configuration.folderId,
    );
    const recordingRows = await db
        .select()
        .from(recordings)
        .where(
            and(
                isOrg
                    ? sharedRecordingCondition(userId)
                    : eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        );
    const refs = recordingRows.map((row) => ({
        id: row.id,
        ownerUserId: row.userId,
    }));
    const [
        transcriptRows,
        summaryRows,
        existingStates,
        existingDirectories,
        existingPlacements,
    ] = await Promise.all([
        isOrg
            ? readOrgViewTranscriptRows(refs, userId).then(({ rows }) =>
                  rows.map((row) => ({
                      id: row.id,
                      recordingId: row.recordingId,
                      source: row.source,
                      userId: row.userId,
                  })),
              )
            : db
                  .select({
                      id: transcriptions.id,
                      recordingId: transcriptions.recordingId,
                      source: transcriptions.source,
                      userId: transcriptions.userId,
                  })
                  .from(transcriptions)
                  .where(eq(transcriptions.userId, userId)),
        isOrg
            ? readOrgViewSummaryRows(refs, userId)
            : db
                  .select({
                      id: aiEnhancements.id,
                      recordingId: aiEnhancements.recordingId,
                      source: aiEnhancements.source,
                      userId: aiEnhancements.userId,
                  })
                  .from(aiEnhancements)
                  .where(eq(aiEnhancements.userId, userId)),
        db
            .select({
                id: folderExportMaterializations.id,
                recordingId: folderExportMaterializations.recordingId,
                placementFolderId:
                    folderExportMaterializations.placementFolderId,
                logicalPath: folderExportMaterializations.logicalPath,
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
            placementKey(placement.recordingId, placement.placementFolderId),
            placement,
        ]),
    );
    const folderPathById = new Map<string, string>([
        [configuration.folderId, configuration.targetPath],
    ]);
    const folderMoves: PathMove[] = [];
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
        const occupied = new Set(
            children.flatMap((folder) => {
                const existing = directoryByFolder.get(folder.id);
                return existing?.targetPath === configuration.targetPath
                    ? [existing.directoryName]
                    : [];
            }),
        );
        for (const folder of children) {
            const existing = directoryByFolder.get(folder.id);
            if (existing?.targetPath === configuration.targetPath) {
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
                ? relocatedPath(storedPrevious, folderMoves)
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
                folderMoves.push({
                    previous: previousPath,
                    current: logicalPath,
                });
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

    const plannedPlacements: Array<{
        recording: (typeof recordingRows)[number];
        placementFolderId: string;
        artifacts: PlannedArtifact[];
        preferredName: string;
    }> = [];
    for (const recording of recordingRows) {
        const placements = exportPlacementFolderIds(
            organization.folders,
            organization.assignments,
            recording.id,
            configuration.folderId,
        ).filter((folderId) => configSubtree.has(folderId));
        if (placements.length === 0) continue;

        const artifacts: PlannedArtifact[] = [];
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
                filename: `audio${audioExtension(
                    recording.storageFilename ?? recording.storagePath,
                )}`,
                size: recording.filesize,
            });
        }
        if (configuration.exportTranscript) {
            for (const transcript of transcriptRows.filter(
                (row) => row.recordingId === recording.id,
            )) {
                const document = await getRecordingMarkdownDocument(
                    transcript.userId,
                    recording.id,
                    "transcript",
                    transcript.source,
                    recording.userId,
                    isOrg,
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
                    summary.source,
                    recording.userId,
                    isOrg,
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
                    });
                }
            }
        }
        for (const placementFolderId of placements) {
            plannedPlacements.push({
                recording,
                placementFolderId,
                artifacts,
                preferredName: recordingDirectory(
                    decryptText(recording.filename),
                ),
            });
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

    let queued = 0;
    const occupiedByFolder = new Map<string, Set<string>>();
    for (const placement of plannedPlacements) {
        const existing = placementByKey.get(
            placementKey(placement.recording.id, placement.placementFolderId),
        );
        if (existing?.targetPath !== configuration.targetPath) continue;
        const occupied =
            occupiedByFolder.get(placement.placementFolderId) ??
            new Set<string>();
        occupied.add(existing.directoryName);
        occupiedByFolder.set(placement.placementFolderId, occupied);
    }
    const expectedStateIds = new Set<string>();
    const plannedPlacementPaths = new Set<string>();
    for (const placement of plannedPlacements) {
        const parentPath = folderPathById.get(placement.placementFolderId);
        if (!parentPath) continue;
        const occupied =
            occupiedByFolder.get(placement.placementFolderId) ??
            new Set<string>();
        occupiedByFolder.set(placement.placementFolderId, occupied);
        const key = placementKey(
            placement.recording.id,
            placement.placementFolderId,
        );
        const existing = placementByKey.get(key);
        const sameTarget = existing?.targetPath === configuration.targetPath;
        if (sameTarget) occupied.delete(existing.directoryName);
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
              : (legacy.placements.get(key) ?? null);
        const previousPath = storedPrevious
            ? relocatedPath(storedPrevious, folderMoves)
            : null;
        const reconciliation = await provider.reconcileDirectory(
            previousPath,
            logicalDirectoryPath,
        );
        const contentPreserved =
            (sameTarget || legacy.placements.has(key)) &&
            reconciliation.contentPreserved;
        await db
            .insert(folderExportPlacements)
            .values({
                userId,
                exportConfigurationId: exportId,
                recordingId: placement.recording.id,
                placementFolderId: placement.placementFolderId,
                targetPath: configuration.targetPath,
                directoryName,
                logicalPath: logicalDirectoryPath,
                expected: true,
            })
            .onConflictDoUpdate({
                target: [
                    folderExportPlacements.exportConfigurationId,
                    folderExportPlacements.recordingId,
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
                    recordingId: placement.recording.id,
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
            if (
                state &&
                (state.status === "pending" || state.status === "failed")
            ) {
                await enqueueExportMaterialization(userId, state.id);
                queued += 1;
            }
            if (state) expectedStateIds.add(state.id);
        }
    }

    const staleIds = existingStates
        .map((state) => state.id)
        .filter((id) => !expectedStateIds.has(id));
    for (let offset = 0; offset < staleIds.length; offset += 500) {
        await db
            .update(folderExportMaterializations)
            .set({ expected: false, updatedAt: new Date() })
            .where(
                and(
                    eq(folderExportMaterializations.userId, userId),
                    eq(
                        folderExportMaterializations.exportConfigurationId,
                        exportId,
                    ),
                    inArray(
                        folderExportMaterializations.id,
                        staleIds.slice(offset, offset + 500),
                    ),
                ),
            );
    }

    await pruneUnplacedDirectories(
        provider,
        [
            ...existingPlacements.filter(
                (placement) =>
                    placement.targetPath === configuration.targetPath,
            ),
            ...existingDirectories.filter(
                (directory) =>
                    directory.targetPath === configuration.targetPath,
            ),
        ].map((row) => relocatedPath(row.logicalPath, folderMoves)),
        new Set([...folderPathById.values(), ...plannedPlacementPaths]),
    );
    return queued;
}

/**
 * Removes the directories of placements and folders this plan no longer
 * has, deepest first so a folder emptied by its last recording goes too.
 * Only empty ones: the export never deletes files, so a directory still
 * holding any is left as it is.
 */
async function pruneUnplacedDirectories(
    provider: ExportProvider,
    previousPaths: string[],
    plannedPaths: ReadonlySet<string>,
): Promise<void> {
    const candidates = [...new Set(previousPaths)]
        .filter((candidate) => !plannedPaths.has(candidate))
        .sort(
            (left, right) =>
                right.split("/").length - left.split("/").length ||
                left.localeCompare(right),
        );
    for (const candidate of candidates) {
        await provider.removeEmptyDirectory(candidate).catch((error) => {
            console.error(
                `[folder-export] could not remove ${candidate}:`,
                error,
            );
        });
    }
}
