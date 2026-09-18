import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    filesystemExportSettings,
    folderExportConfigurations,
    folderExportMaterializations,
    recordings,
    transcriptions,
} from "@/db/schema";
import { getRecordingMarkdownDocument } from "@/lib/export/document-sidecars";
import { listFolderOrganization } from "@/lib/folders/folders";
import {
    ancestorFolderIds,
    descendantFolderIds,
} from "@/lib/folders/hierarchy";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { enqueueExportMaterialization, enqueueExportPlan } from "./jobs";
import { planFolderExport } from "./planner";
import { createExportProvider } from "./provider-factory";

function digest(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

export async function materializeFolderExport(
    userId: string,
    materializationId: string,
): Promise<boolean> {
    const [state] = await db
        .select({
            id: folderExportMaterializations.id,
            recordingId: folderExportMaterializations.recordingId,
            artifactId: folderExportMaterializations.artifactId,
            artifactType: folderExportMaterializations.artifactType,
            artifactVersion: folderExportMaterializations.artifactVersion,
            logicalPath: folderExportMaterializations.logicalPath,
            expected: folderExportMaterializations.expected,
            status: folderExportMaterializations.status,
            exportId: folderExportMaterializations.exportConfigurationId,
            provider: folderExportConfigurations.provider,
            targetPath: filesystemExportSettings.targetPath,
            storagePath: recordings.storagePath,
            fileMd5: recordings.fileMd5,
            plaudVersion: recordings.plaudVersion,
            filesize: recordings.filesize,
        })
        .from(folderExportMaterializations)
        .innerJoin(
            folderExportConfigurations,
            eq(
                folderExportConfigurations.id,
                folderExportMaterializations.exportConfigurationId,
            ),
        )
        .innerJoin(
            filesystemExportSettings,
            eq(
                filesystemExportSettings.exportConfigurationId,
                folderExportConfigurations.id,
            ),
        )
        .innerJoin(
            recordings,
            eq(recordings.id, folderExportMaterializations.recordingId),
        )
        .where(
            and(
                eq(folderExportMaterializations.id, materializationId),
                eq(folderExportMaterializations.userId, userId),
                eq(folderExportConfigurations.userId, userId),
                eq(recordings.userId, userId),
            ),
        )
        .limit(1);
    if (!state || !state.expected || state.status === "exported") return false;

    await db
        .update(folderExportMaterializations)
        .set({
            status: "in_progress",
            attempts: sqlIncrement(folderExportMaterializations.attempts),
            lastError: null,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(folderExportMaterializations.id, state.id),
                eq(folderExportMaterializations.userId, userId),
            ),
        );

    try {
        const provider = createExportProvider(state.provider);
        if (state.artifactType === "audio") {
            const currentVersion = digest(
                [
                    state.fileMd5,
                    state.plaudVersion,
                    state.storagePath,
                    state.filesize,
                ].join(":"),
            );
            if (currentVersion !== state.artifactVersion) {
                await markProjectionStale(userId, state.id);
                await enqueueExportPlan(userId, state.exportId);
                return false;
            }
            const storage = await createUserStorageProvider(userId);
            await provider.materialize(
                state.logicalPath,
                await storage.downloadStream(state.storagePath),
            );
        } else {
            const source =
                state.artifactType === "transcript"
                    ? await db
                          .select({ source: transcriptions.source })
                          .from(transcriptions)
                          .where(
                              and(
                                  eq(transcriptions.id, state.artifactId),
                                  eq(transcriptions.userId, userId),
                              ),
                          )
                          .limit(1)
                    : await db
                          .select({ source: aiEnhancements.source })
                          .from(aiEnhancements)
                          .where(
                              and(
                                  eq(aiEnhancements.id, state.artifactId),
                                  eq(aiEnhancements.userId, userId),
                              ),
                          )
                          .limit(1);
            const document = source[0]
                ? await getRecordingMarkdownDocument(
                      userId,
                      state.recordingId,
                      state.artifactType,
                      source[0].source,
                  )
                : null;
            if (!document) {
                await markProjectionStale(userId, state.id);
                await enqueueExportPlan(userId, state.exportId);
                return false;
            }
            const content = Buffer.from(document.content);
            if (digest(content) !== state.artifactVersion) {
                await markProjectionStale(userId, state.id);
                await enqueueExportPlan(userId, state.exportId);
                return false;
            }
            await provider.materialize(state.logicalPath, content);
        }
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
                    eq(folderExportMaterializations.id, state.id),
                    eq(folderExportMaterializations.userId, userId),
                    eq(
                        folderExportMaterializations.artifactVersion,
                        state.artifactVersion,
                    ),
                    eq(folderExportMaterializations.expected, true),
                ),
            );
        return true;
    } catch (error) {
        await db
            .update(folderExportMaterializations)
            .set({
                status: "failed",
                lastError: (error instanceof Error
                    ? error.message
                    : String(error)
                ).slice(0, 2000),
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(folderExportMaterializations.id, state.id),
                    eq(folderExportMaterializations.userId, userId),
                ),
            );
        throw error;
    }
}

export async function reconcileFolderExport(
    userId: string,
    selectedFolderId: string,
): Promise<{ checked: number; pending: number }> {
    const organization = await listFolderOrganization(userId);
    if (
        !organization.folders.some((folder) => folder.id === selectedFolderId)
    ) {
        return { checked: 0, pending: 0 };
    }
    const ancestors = ancestorFolderIds(organization.folders, selectedFolderId);
    const subtree = descendantFolderIds(organization.folders, selectedFolderId);
    const configurations = await db
        .select({
            id: folderExportConfigurations.id,
            provider: folderExportConfigurations.provider,
        })
        .from(folderExportConfigurations)
        .where(
            and(
                eq(folderExportConfigurations.userId, userId),
                inArray(folderExportConfigurations.folderId, [...ancestors]),
            ),
        );
    if (configurations.length === 0) return { checked: 0, pending: 0 };
    for (const configuration of configurations) {
        await planFolderExport(userId, configuration.id);
    }
    const states = await db
        .select({
            id: folderExportMaterializations.id,
            exportId: folderExportMaterializations.exportConfigurationId,
            logicalPath: folderExportMaterializations.logicalPath,
            expectedSize: folderExportMaterializations.expectedSize,
        })
        .from(folderExportMaterializations)
        .where(
            and(
                eq(folderExportMaterializations.userId, userId),
                eq(folderExportMaterializations.expected, true),
                inArray(
                    folderExportMaterializations.exportConfigurationId,
                    configurations.map((configuration) => configuration.id),
                ),
                inArray(folderExportMaterializations.placementFolderId, [
                    ...subtree,
                ]),
            ),
        );
    const providerByExport = new Map(
        configurations.map((configuration) => [
            configuration.id,
            createExportProvider(configuration.provider),
        ]),
    );
    let pending = 0;
    for (const state of states) {
        const exists = await providerByExport
            .get(state.exportId)
            ?.exists(state.logicalPath, state.expectedSize);
        if (exists) {
            await db
                .update(folderExportMaterializations)
                .set({
                    status: "exported",
                    exportedAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(folderExportMaterializations.id, state.id),
                        eq(folderExportMaterializations.userId, userId),
                    ),
                );
        } else {
            await db
                .update(folderExportMaterializations)
                .set({ status: "pending", updatedAt: new Date() })
                .where(
                    and(
                        eq(folderExportMaterializations.id, state.id),
                        eq(folderExportMaterializations.userId, userId),
                    ),
                );
            await enqueueExportMaterialization(userId, state.id);
            pending += 1;
        }
    }
    return { checked: states.length, pending };
}

function sqlIncrement(column: typeof folderExportMaterializations.attempts) {
    return sql`${column} + 1`;
}

async function markProjectionStale(userId: string, id: string): Promise<void> {
    await db
        .update(folderExportMaterializations)
        .set({ expected: false, status: "pending", updatedAt: new Date() })
        .where(
            and(
                eq(folderExportMaterializations.id, id),
                eq(folderExportMaterializations.userId, userId),
            ),
        );
}
