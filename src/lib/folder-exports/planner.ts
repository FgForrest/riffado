import { createHash } from "node:crypto";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    filesystemExportSettings,
    folderExportConfigurations,
    folderExportMaterializations,
    recordings,
    transcriptions,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { getRecordingMarkdownDocument } from "@/lib/export/document-sidecars";
import { listFolderOrganization } from "@/lib/folders/folders";
import {
    descendantFolderIds,
    exportPlacementFolderIds,
    relativeFolderChain,
} from "@/lib/folders/hierarchy";
import { enqueueExportMaterialization } from "./jobs";
import {
    audioExtension,
    folderDirectory,
    recordingDirectory,
    sourceFilename,
} from "./naming";
import type { ExportArtifactType } from "./types";

interface PlannedArtifact {
    artifactType: ExportArtifactType;
    artifactId: string;
    version: string;
    filename: string;
    size: number;
}

function digest(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

export async function planFolderExport(
    userId: string,
    exportId: string,
): Promise<number> {
    const [configuration] = await db
        .select({
            id: folderExportConfigurations.id,
            folderId: folderExportConfigurations.folderId,
            targetPath: filesystemExportSettings.targetPath,
            exportAudio: folderExportConfigurations.exportAudio,
            exportTranscript: folderExportConfigurations.exportTranscript,
            exportSummary: folderExportConfigurations.exportSummary,
        })
        .from(folderExportConfigurations)
        .innerJoin(
            filesystemExportSettings,
            eq(
                filesystemExportSettings.exportConfigurationId,
                folderExportConfigurations.id,
            ),
        )
        .where(
            and(
                eq(folderExportConfigurations.id, exportId),
                eq(folderExportConfigurations.userId, userId),
            ),
        )
        .limit(1);
    if (!configuration) return 0;

    const organization = await listFolderOrganization(userId);
    const configSubtree = descendantFolderIds(
        organization.folders,
        configuration.folderId,
    );
    const [recordingRows, transcriptRows, summaryRows, existingStates] =
        await Promise.all([
            db
                .select()
                .from(recordings)
                .where(
                    and(
                        eq(recordings.userId, userId),
                        isNull(recordings.deletedAt),
                    ),
                ),
            db
                .select({
                    id: transcriptions.id,
                    recordingId: transcriptions.recordingId,
                    source: transcriptions.source,
                })
                .from(transcriptions)
                .where(eq(transcriptions.userId, userId)),
            db
                .select({
                    id: aiEnhancements.id,
                    recordingId: aiEnhancements.recordingId,
                    source: aiEnhancements.source,
                })
                .from(aiEnhancements)
                .where(eq(aiEnhancements.userId, userId)),
            db
                .select({ id: folderExportMaterializations.id })
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
        ]);

    let queued = 0;
    const expectedStateIds = new Set<string>();
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
                    userId,
                    recording.id,
                    "transcript",
                    transcript.source,
                );
                if (!document) continue;
                const content = Buffer.from(document.content);
                artifacts.push({
                    artifactType: "transcript",
                    artifactId: transcript.id,
                    version: digest(content),
                    filename: sourceFilename(transcript.source, "transcript"),
                    size: content.byteLength,
                });
            }
        }
        if (configuration.exportSummary) {
            for (const summary of summaryRows.filter(
                (row) => row.recordingId === recording.id,
            )) {
                const document = await getRecordingMarkdownDocument(
                    userId,
                    recording.id,
                    "summary",
                    summary.source,
                );
                if (!document) continue;
                const content = Buffer.from(document.content);
                artifacts.push({
                    artifactType: "summary",
                    artifactId: summary.id,
                    version: digest(content),
                    filename: sourceFilename(summary.source, "summary"),
                    size: content.byteLength,
                });
            }
        }

        for (const placementFolderId of placements) {
            const relative = relativeFolderChain(
                organization.folders,
                configuration.folderId,
                placementFolderId,
            );
            if (!relative) continue;
            const directory = recordingDirectory(
                decryptText(recording.filename),
                recording.id,
            );
            for (const artifact of artifacts) {
                const logicalPath = path.posix.join(
                    configuration.targetPath,
                    ...relative.map((segment) =>
                        folderDirectory(segment.name, segment.id),
                    ),
                    directory,
                    artifact.filename,
                );
                const [state] = await db
                    .insert(folderExportMaterializations)
                    .values({
                        userId,
                        exportConfigurationId: exportId,
                        recordingId: recording.id,
                        placementFolderId,
                        artifactType: artifact.artifactType,
                        artifactId: artifact.artifactId,
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
                        ],
                        set: {
                            artifactVersion: artifact.version,
                            logicalPath,
                            expectedSize: artifact.size,
                            expected: true,
                            status: sql`case when ${folderExportMaterializations.artifactVersion} <> ${artifact.version} or ${folderExportMaterializations.logicalPath} <> ${logicalPath} or ${folderExportMaterializations.expectedSize} <> ${artifact.size} or not ${folderExportMaterializations.expected} then 'pending' else ${folderExportMaterializations.status} end`,
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
    return queued;
}
