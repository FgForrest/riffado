import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
    filesystemExportSettings,
    folderExportConfigurations,
    googleDriveExportSettings,
    recordingFolders,
} from "@/db/schema";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { applicableExportConfigurationIds } from "@/lib/folders/hierarchy";
import { isGoogleIntegrationAvailable } from "@/lib/integrations/google/config";
import { inspectDriveFolder } from "@/lib/integrations/google/drive-folders";
import { assertOrgScopeWritable, isOrgAccount } from "@/lib/org/config";
import { validateRelativeExportPath } from "./filesystem-provider";
import { enqueueExportPlan } from "./jobs";
import {
    listExportTargets,
    loadExportTarget,
    toConfigurationDto,
} from "./target";
import type {
    DocumentFormat,
    ExportProvidersAvailability,
    FolderExportConfigurationDto,
    FolderExportProviderType,
} from "./types";

interface SaveFolderExportCommon {
    exportAudio: boolean;
    exportTranscript: boolean;
    exportSummary: boolean;
}

export type SaveFolderExportInput = SaveFolderExportCommon &
    (
        | { provider?: "filesystem"; targetPath: string }
        | {
              provider: "google-drive";
              rootFolderId: string;
              transcriptFormat: DocumentFormat;
              summaryFormat: DocumentFormat;
          }
    );

const DOCUMENT_FORMATS: ReadonlySet<string> = new Set([
    "markdown",
    "google_doc",
    "both",
]);

export function isDocumentFormat(value: unknown): value is DocumentFormat {
    return typeof value === "string" && DOCUMENT_FORMATS.has(value);
}

export function exportProvidersAvailability(): ExportProvidersAvailability {
    return {
        filesystem: !env.IS_HOSTED && Boolean(env.FILESYSTEM_EXPORT_ROOT),
        googleDrive: isGoogleIntegrationAvailable(),
    };
}

function assertProviderAvailable(provider: FolderExportProviderType): void {
    const available = exportProvidersAvailability();
    if (provider === "filesystem" && !available.filesystem) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Filesystem exports are not available on this deployment",
            404,
        );
    }
    if (provider === "google-drive" && !available.googleDrive) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Google Drive exports are not available on this deployment",
            404,
        );
    }
}

/** Folder exports exist on this deployment through at least one provider. */
export function assertFolderExportsAvailable(): void {
    const available = exportProvidersAvailability();
    if (!available.filesystem && !available.googleDrive) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Folder exports are not available on this deployment",
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

function providerOf(input: SaveFolderExportInput): FolderExportProviderType {
    return input.provider ?? "filesystem";
}

function filesystemTargetPath(targetPath: string): string {
    try {
        return validateRelativeExportPath(targetPath);
    } catch (error) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            error instanceof Error ? error.message : "Invalid export path",
            400,
            { field: "targetPath" },
        );
    }
}

/**
 * Exports are configured in Private, or by the organization account in the
 * Organization tree, which is its own.
 */
async function assertExportableFolder(userId: string, folderId: string) {
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
    if (current?.kind === "public" && (await isOrgAccount(userId))) {
        assertOrgScopeWritable();
        return;
    }
    if (!current || current.kind !== "private") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Exports can only be configured in Private",
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
    assertFolderExportsAvailable();
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
    const targets = await listExportTargets(userId);
    return {
        configured: targets
            .filter((target) => target.folderId === folderId)
            .map(toConfigurationDto),
        applicableIds: applicableExportConfigurationIds(
            folders,
            folderId,
            targets,
        ),
    };
}

export async function createFolderExport(
    userId: string,
    folderId: string,
    input: SaveFolderExportInput,
): Promise<FolderExportConfigurationDto> {
    const provider = providerOf(input);
    assertProviderAvailable(provider);
    validateSelection(input);
    await assertExportableFolder(userId, folderId);
    const targetPath =
        input.provider === "google-drive"
            ? null
            : filesystemTargetPath(input.targetPath);
    const drive =
        input.provider === "google-drive"
            ? await inspectDriveFolder(userId, input.rootFolderId)
            : null;
    const configuration = await db.transaction(async (tx) => {
        const [created] = await tx
            .insert(folderExportConfigurations)
            .values({
                userId,
                folderId,
                provider,
                exportAudio: input.exportAudio,
                exportTranscript: input.exportTranscript,
                exportSummary: input.exportSummary,
            })
            .returning();
        if (!created) throw new Error("Export configuration was not created");
        if (targetPath !== null) {
            await tx.insert(filesystemExportSettings).values({
                exportConfigurationId: created.id,
                userId,
                targetPath,
            });
        }
        if (drive && input.provider === "google-drive") {
            await tx.insert(googleDriveExportSettings).values({
                exportConfigurationId: created.id,
                userId,
                accountSubject: drive.accountSubject,
                rootFolderId: drive.id,
                rootFolderName: drive.name,
                driveId: drive.driveId,
                transcriptFormat: input.transcriptFormat,
                summaryFormat: input.summaryFormat,
            });
        }
        return created;
    });
    await enqueueExportPlan(userId, configuration.id);
    return savedDto(userId, configuration.id);
}

export async function updateFolderExport(
    userId: string,
    folderId: string,
    exportId: string,
    input: SaveFolderExportInput,
): Promise<FolderExportConfigurationDto> {
    const provider = providerOf(input);
    assertProviderAvailable(provider);
    validateSelection(input);
    const existing = await loadExportTarget(userId, exportId);
    if (!existing || existing.folderId !== folderId) {
        throw new AppError(ErrorCode.NOT_FOUND, "Export not found", 404);
    }
    if (existing.provider !== provider) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "The provider of an export cannot change",
            400,
        );
    }
    const targetPath =
        input.provider === "google-drive"
            ? null
            : filesystemTargetPath(input.targetPath);
    const drive =
        input.provider === "google-drive"
            ? await inspectDriveFolder(userId, input.rootFolderId)
            : null;
    await db.transaction(async (tx) => {
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
        if (targetPath !== null) {
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
        }
        if (drive && input.provider === "google-drive") {
            await tx
                .update(googleDriveExportSettings)
                .set({
                    accountSubject: drive.accountSubject,
                    rootFolderId: drive.id,
                    rootFolderName: drive.name,
                    driveId: drive.driveId,
                    transcriptFormat: input.transcriptFormat,
                    summaryFormat: input.summaryFormat,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(
                            googleDriveExportSettings.exportConfigurationId,
                            exportId,
                        ),
                        eq(googleDriveExportSettings.userId, userId),
                    ),
                );
        }
    });
    await enqueueExportPlan(userId, exportId);
    return savedDto(userId, exportId);
}

async function savedDto(
    userId: string,
    exportId: string,
): Promise<FolderExportConfigurationDto> {
    const target = await loadExportTarget(userId, exportId);
    if (!target) throw new Error("Saved export configuration disappeared");
    return toConfigurationDto(target);
}

export async function deleteFolderExport(
    userId: string,
    folderId: string,
    exportId: string,
): Promise<void> {
    assertFolderExportsAvailable();
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
