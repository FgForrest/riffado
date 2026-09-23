import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
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
import { listExportFolderOrganization } from "@/lib/folders/folders";
import {
    ancestorFolderIds,
    descendantFolderIds,
} from "@/lib/folders/hierarchy";
import { isOrgAccount } from "@/lib/org/config";
import { sharedRecordingCondition } from "@/lib/sharing/shared";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { enqueueExportMaterialization, enqueueExportPlan } from "./jobs";
import { withExportLock } from "./lock";
import { planFolderExport } from "./planner";
import { createExportProvider } from "./provider-factory";
import type { FolderExportProviderType } from "./types";

function digest(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

export async function materializeFolderExport(
    userId: string,
    materializationId: string,
): Promise<boolean> {
    const [owner] = await db
        .select({
            exportId: folderExportMaterializations.exportConfigurationId,
        })
        .from(folderExportMaterializations)
        .where(
            and(
                eq(folderExportMaterializations.id, materializationId),
                eq(folderExportMaterializations.userId, userId),
            ),
        )
        .limit(1);
    if (!owner) return false;
    // The path is read under the lock, so a rename cannot move it between
    // the read and the write.
    return withExportLock(owner.exportId, "shared", () =>
        materializeLocked(userId, materializationId),
    );
}

async function materializeLocked(
    userId: string,
    materializationId: string,
): Promise<boolean> {
    // The organization account's exports carry other people's shared
    // recordings; everyone else's carry only their own.
    const isOrg = await isOrgAccount(userId);
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
            ownerUserId: recordings.userId,
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
                isOrg
                    ? sharedRecordingCondition(userId)
                    : eq(recordings.userId, userId),
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
            const storage = await createUserStorageProvider(state.ownerUserId);
            await provider.materialize(
                state.logicalPath,
                await storage.downloadStream(state.storagePath),
            );
        } else {
            // The Organization view may still be showing the owner's rows.
            const readers = [userId, state.ownerUserId];
            const source =
                state.artifactType === "transcript"
                    ? await db
                          .select({
                              source: transcriptions.source,
                              userId: transcriptions.userId,
                          })
                          .from(transcriptions)
                          .where(
                              and(
                                  eq(transcriptions.id, state.artifactId),
                                  eq(
                                      transcriptions.recordingId,
                                      state.recordingId,
                                  ),
                                  or(
                                      ...readers.map((reader) =>
                                          eq(transcriptions.userId, reader),
                                      ),
                                  ),
                              ),
                          )
                          .limit(1)
                    : await db
                          .select({
                              source: aiEnhancements.source,
                              userId: aiEnhancements.userId,
                          })
                          .from(aiEnhancements)
                          .where(
                              and(
                                  eq(aiEnhancements.id, state.artifactId),
                                  eq(
                                      aiEnhancements.recordingId,
                                      state.recordingId,
                                  ),
                                  or(
                                      ...readers.map((reader) =>
                                          eq(aiEnhancements.userId, reader),
                                      ),
                                  ),
                              ),
                          )
                          .limit(1);
            const document = source[0]
                ? await getRecordingMarkdownDocument(
                      source[0].userId,
                      state.recordingId,
                      state.artifactType,
                      source[0].source,
                      state.ownerUserId,
                      isOrg,
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
    const organization = await listExportFolderOrganization(userId);
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
    let checked = 0;
    let pending = 0;
    for (const configuration of configurations) {
        const result = await withExportLock(configuration.id, "shared", () =>
            checkMaterializations(userId, configuration, subtree),
        );
        checked += result.checked;
        pending += result.pending;
    }
    return { checked, pending };
}

/** Compares one export's expected files with the disk, under its lock. */
async function checkMaterializations(
    userId: string,
    configuration: { id: string; provider: FolderExportProviderType },
    subtree: ReadonlySet<string>,
): Promise<{ checked: number; pending: number }> {
    const provider = createExportProvider(configuration.provider);
    const states = await db
        .select({
            id: folderExportMaterializations.id,
            logicalPath: folderExportMaterializations.logicalPath,
            expectedSize: folderExportMaterializations.expectedSize,
        })
        .from(folderExportMaterializations)
        .where(
            and(
                eq(folderExportMaterializations.userId, userId),
                eq(folderExportMaterializations.expected, true),
                eq(
                    folderExportMaterializations.exportConfigurationId,
                    configuration.id,
                ),
                inArray(folderExportMaterializations.placementFolderId, [
                    ...subtree,
                ]),
            ),
        );
    let pending = 0;
    for (const state of states) {
        const exists = await provider.exists(
            state.logicalPath,
            state.expectedSize,
        );
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
