import { and, eq, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
    filesystemExportSettings,
    folderExportConfigurations,
    googleDriveExportSettings,
} from "@/db/schema";
import type {
    FolderExportConfigurationDto,
    FolderExportProviderType,
    GoogleDriveExportDto,
} from "./types";

export interface GoogleDriveTarget extends GoogleDriveExportDto {
    accountSubject: string;
}

/** One export configuration with the settings of its provider. */
export interface ExportTarget {
    id: string;
    userId: string;
    folderId: string;
    provider: FolderExportProviderType;
    /**
     * First segment of every logical path the export plans: the path under
     * the filesystem root, or the id of the picked Drive folder.
     */
    targetPath: string;
    exportAudio: boolean;
    exportTranscript: boolean;
    exportSummary: boolean;
    googleDrive: GoogleDriveTarget | null;
    lastError: string | null;
    lastErrorAt: Date | null;
}

async function selectTargets(where: SQL | undefined): Promise<ExportTarget[]> {
    const rows = await db
        .select({
            id: folderExportConfigurations.id,
            userId: folderExportConfigurations.userId,
            folderId: folderExportConfigurations.folderId,
            provider: folderExportConfigurations.provider,
            exportAudio: folderExportConfigurations.exportAudio,
            exportTranscript: folderExportConfigurations.exportTranscript,
            exportSummary: folderExportConfigurations.exportSummary,
            lastError: folderExportConfigurations.lastError,
            lastErrorAt: folderExportConfigurations.lastErrorAt,
            filesystemPath: filesystemExportSettings.targetPath,
            drive: {
                accountSubject: googleDriveExportSettings.accountSubject,
                rootFolderId: googleDriveExportSettings.rootFolderId,
                rootFolderName: googleDriveExportSettings.rootFolderName,
                driveId: googleDriveExportSettings.driveId,
                transcriptFormat: googleDriveExportSettings.transcriptFormat,
                summaryFormat: googleDriveExportSettings.summaryFormat,
            },
        })
        .from(folderExportConfigurations)
        .leftJoin(
            filesystemExportSettings,
            eq(
                filesystemExportSettings.exportConfigurationId,
                folderExportConfigurations.id,
            ),
        )
        .leftJoin(
            googleDriveExportSettings,
            eq(
                googleDriveExportSettings.exportConfigurationId,
                folderExportConfigurations.id,
            ),
        )
        .where(where);
    return rows.flatMap((row): ExportTarget[] => {
        const common = {
            id: row.id,
            userId: row.userId,
            folderId: row.folderId,
            exportAudio: row.exportAudio,
            exportTranscript: row.exportTranscript,
            exportSummary: row.exportSummary,
            lastError: row.lastError,
            lastErrorAt: row.lastErrorAt,
        };
        if (row.provider === "filesystem") {
            return row.filesystemPath
                ? [
                      {
                          ...common,
                          provider: "filesystem",
                          targetPath: row.filesystemPath,
                          googleDrive: null,
                      },
                  ]
                : [];
        }
        return row.drive
            ? [
                  {
                      ...common,
                      provider: "google-drive",
                      targetPath: row.drive.rootFolderId,
                      googleDrive: row.drive,
                  },
              ]
            : [];
    });
}

/** The export `exportId` of `userId`, or null if it has none. */
export async function loadExportTarget(
    userId: string,
    exportId: string,
): Promise<ExportTarget | null> {
    const [target] = await selectTargets(
        and(
            eq(folderExportConfigurations.id, exportId),
            eq(folderExportConfigurations.userId, userId),
        ),
    );
    return target ?? null;
}

/** Every export of `userId`. */
export function listExportTargets(userId: string): Promise<ExportTarget[]> {
    return selectTargets(eq(folderExportConfigurations.userId, userId));
}

export function toConfigurationDto(
    target: ExportTarget,
): FolderExportConfigurationDto {
    const drive = target.googleDrive;
    return {
        id: target.id,
        folderId: target.folderId,
        provider: target.provider,
        targetPath: target.targetPath,
        exportAudio: target.exportAudio,
        exportTranscript: target.exportTranscript,
        exportSummary: target.exportSummary,
        lastError: target.lastError,
        lastErrorAt: target.lastErrorAt?.toISOString() ?? null,
        googleDrive: drive
            ? {
                  rootFolderId: drive.rootFolderId,
                  rootFolderName: drive.rootFolderName,
                  driveId: drive.driveId,
                  transcriptFormat: drive.transcriptFormat,
                  summaryFormat: drive.summaryFormat,
              }
            : null,
    };
}
