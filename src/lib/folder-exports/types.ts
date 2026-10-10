import type { Readable } from "node:stream";

/**
 * What one exported file is: a recording's audio, transcript or summary, or
 * a mail as it arrived (`.eml`) and as a Markdown document of it.
 */
export type ExportArtifactType =
    | "audio"
    | "transcript"
    | "summary"
    | "mail"
    | "mail_document";
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

export type OwnedEntryKind = "directory" | "file";

export interface TakenNames {
    names: Set<string>;
    foreign: Set<string>;
}

/**
 * A target the export writes into. It tracks every file and directory it
 * creates and never moves, overwrites or deletes anything else.
 */
export interface ExportProvider {
    /** Whether the export's own file at the path matches `expected`. */
    exists(relativePath: string, expected: ExpectedArtifact): Promise<boolean>;
    /**
     * Names taken in a directory: all of them, and those of entries the
     * export did not create.
     */
    takenNames(relativePath: string): Promise<TakenNames>;
    /**
     * Makes sure the directory at `currentPath` exists, moving the one at
     * `previousPath` there as a whole when that is safe. `contentPreserved`
     * says whether files written under the previous path are now under the
     * current one.
     */
    reconcileDirectory(
        previousPath: string | null,
        currentPath: string,
    ): Promise<{ contentPreserved: boolean }>;
    /** Moves one of the export's files to a free path. True if moved. */
    moveFile(from: string, to: string): Promise<boolean>;
    /**
     * Removes one of the export's files it no longer places. `duplicate`:
     * the same artifact has another path in the plan. True if removed.
     */
    removeFile(
        relativePath: string,
        options: { duplicate: boolean },
    ): Promise<boolean>;
    /**
     * Removes a directory the export created and no longer places anything
     * in, but only while it holds nothing of the export's own. True if
     * removed.
     */
    removeEmptyDirectory(relativePath: string): Promise<boolean>;
    /** Every entry the export created, by path. */
    ownedEntries(): Promise<Map<string, OwnedEntryKind>>;
    /** Forgets entries the export created that are gone from the target. */
    forgetMissing(): Promise<void>;
    /**
     * Takes entries written before the export tracked what it creates as
     * its own, where they still exist with the expected kind.
     */
    adopt(entries: ReadonlyMap<string, OwnedEntryKind>): Promise<void>;
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
    exportMail: boolean;
    googleDrive: GoogleDriveExportDto | null;
    /** Why the export stopped, when only the user can fix it. */
    lastError: string | null;
    lastErrorAt: string | null;
}

export interface ExportProvidersAvailability {
    filesystem: boolean;
    googleDrive: boolean;
    /** Mail is on here, so an export can carry it. */
    mail: boolean;
}
