import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
    filesystemExportSettings,
    folderExportConfigurations,
    recordingFolders,
} from "@/db/schema";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { applicableExportConfigurationIds } from "@/lib/folders/hierarchy";
import { validateRelativeExportPath } from "./filesystem-provider";
import { enqueueExportPlan } from "./jobs";
import type { FolderExportConfigurationDto } from "./types";

export interface SaveFolderExportInput {
    targetPath: string;
    exportAudio: boolean;
    exportTranscript: boolean;
    exportSummary: boolean;
}

export function assertFilesystemExportsAvailable(): void {
    if (env.IS_HOSTED || !env.FILESYSTEM_EXPORT_ROOT) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Filesystem exports are not available on this deployment",
            404,
        );
    }
}

function validateSelection(input: SaveFolderExportInput): void {
    if (!input.exportAudio && !input.exportTranscript && !input.exportSummary) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Enable at least one artifact type",
            400,
        );
    }
}

async function assertPrivateFolder(userId: string, folderId: string) {
    const folders = await db
        .select({
            id: recordingFolders.id,
            parentId: recordingFolders.parentId,
            kind: recordingFolders.kind,
        })
        .from(recordingFolders)
        .where(eq(recordingFolders.userId, userId));
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    let current = byId.get(folderId);
    while (current?.parentId) current = byId.get(current.parentId);
    if (!current || current.kind !== "private") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Filesystem exports can only be configured in Private",
            400,
        );
    }
}

export async function listFolderExports(
    userId: string,
    folderId: string,
): Promise<{
    configured: FolderExportConfigurationDto[];
    applicableIds: string[];
}> {
    assertFilesystemExportsAvailable();
    const folders = await db
        .select({
            id: recordingFolders.id,
            parentId: recordingFolders.parentId,
        })
        .from(recordingFolders)
        .where(eq(recordingFolders.userId, userId));
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    if (!byId.has(folderId)) {
        throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    }
    const rows = await db
        .select({
            id: folderExportConfigurations.id,
            folderId: folderExportConfigurations.folderId,
            provider: folderExportConfigurations.provider,
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
        .where(eq(folderExportConfigurations.userId, userId));
    return {
        configured: rows.filter((row) => row.folderId === folderId),
        applicableIds: applicableExportConfigurationIds(
            folders,
            folderId,
            rows,
        ),
    };
}

export async function createFolderExport(
    userId: string,
    folderId: string,
    input: SaveFolderExportInput,
): Promise<FolderExportConfigurationDto> {
    assertFilesystemExportsAvailable();
    validateSelection(input);
    await assertPrivateFolder(userId, folderId);
    let targetPath: string;
    try {
        targetPath = validateRelativeExportPath(input.targetPath);
    } catch (error) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            error instanceof Error ? error.message : "Invalid export path",
            400,
            { field: "targetPath" },
        );
    }
    const configuration = await db.transaction(async (tx) => {
        const [created] = await tx
            .insert(folderExportConfigurations)
            .values({
                userId,
                folderId,
                provider: "filesystem",
                exportAudio: input.exportAudio,
                exportTranscript: input.exportTranscript,
                exportSummary: input.exportSummary,
            })
            .returning();
        if (!created) throw new Error("Export configuration was not created");
        await tx.insert(filesystemExportSettings).values({
            exportConfigurationId: created.id,
            userId,
            targetPath,
        });
        return created;
    });
    await enqueueExportPlan(userId, configuration.id);
    return { ...configuration, targetPath };
}

export async function updateFolderExport(
    userId: string,
    folderId: string,
    exportId: string,
    input: SaveFolderExportInput,
): Promise<FolderExportConfigurationDto> {
    assertFilesystemExportsAvailable();
    validateSelection(input);
    let targetPath: string;
    try {
        targetPath = validateRelativeExportPath(input.targetPath);
    } catch (error) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            error instanceof Error ? error.message : "Invalid export path",
            400,
            { field: "targetPath" },
        );
    }
    const result = await db.transaction(async (tx) => {
        const [updated] = await tx
            .update(folderExportConfigurations)
            .set({
                exportAudio: input.exportAudio,
                exportTranscript: input.exportTranscript,
                exportSummary: input.exportSummary,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(folderExportConfigurations.id, exportId),
                    eq(folderExportConfigurations.userId, userId),
                    eq(folderExportConfigurations.folderId, folderId),
                ),
            )
            .returning();
        if (!updated) {
            throw new AppError(ErrorCode.NOT_FOUND, "Export not found", 404);
        }
        await tx
            .update(filesystemExportSettings)
            .set({ targetPath, updatedAt: new Date() })
            .where(
                and(
                    eq(
                        filesystemExportSettings.exportConfigurationId,
                        exportId,
                    ),
                    eq(filesystemExportSettings.userId, userId),
                ),
            );
        return updated;
    });
    await enqueueExportPlan(userId, exportId);
    return { ...result, targetPath };
}

export async function deleteFolderExport(
    userId: string,
    folderId: string,
    exportId: string,
): Promise<void> {
    assertFilesystemExportsAvailable();
    const deleted = await db
        .delete(folderExportConfigurations)
        .where(
            and(
                eq(folderExportConfigurations.id, exportId),
                eq(folderExportConfigurations.userId, userId),
                eq(folderExportConfigurations.folderId, folderId),
            ),
        )
        .returning({ id: folderExportConfigurations.id });
    if (deleted.length === 0) {
        throw new AppError(ErrorCode.NOT_FOUND, "Export not found", 404);
    }
}
