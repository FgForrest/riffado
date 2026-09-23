import type { Readable } from "node:stream";

export type ExportArtifactType = "audio" | "transcript" | "summary";
export type FolderExportProviderType = "filesystem" | "google-drive";

/** How one artifact lands in the target: a plain file, or a Google Doc. */
export type ExportFormat = "file" | "google_doc";

/** Formats a Google Drive export writes a Markdown artifact type in. */
export type DocumentFormat = "markdown" | "google_doc" | "both";

export interface ExpectedArtifact {
    size: number;
    /** Digest of the content the planner projected. */
    version: string;
    format: ExportFormat;
}

export interface MaterializeOptions {
    version: string;
    format: ExportFormat;
}

export interface ExportProvider {
    exists(relativePath: string, expected: ExpectedArtifact): Promise<boolean>;
    reconcileDirectory(
        previousPath: string | null,
        currentPath: string,
    ): Promise<{ contentPreserved: boolean }>;
    /**
     * Removes a directory the export no longer places anything in, but only
     * while it holds nothing of the export's own. True if removed.
     */
    removeEmptyDirectory(relativePath: string): Promise<boolean>;
    materialize(
        relativePath: string,
        content: Buffer | Readable,
        options: MaterializeOptions,
    ): Promise<void>;
}

export interface GoogleDriveExportDto {
    rootFolderId: string;
    rootFolderName: string;
    driveId: string | null;
    transcriptFormat: DocumentFormat;
    summaryFormat: DocumentFormat;
}

export interface FolderExportConfigurationDto {
    id: string;
    folderId: string;
    provider: FolderExportProviderType;
    /** Filesystem: the path under the export root. Drive: the folder id. */
    targetPath: string;
    exportAudio: boolean;
    exportTranscript: boolean;
    exportSummary: boolean;
    googleDrive: GoogleDriveExportDto | null;
    /** Why the export stopped, when only the user can fix it. */
    lastError: string | null;
    lastErrorAt: string | null;
}

export interface ExportProvidersAvailability {
    filesystem: boolean;
    googleDrive: boolean;
}
