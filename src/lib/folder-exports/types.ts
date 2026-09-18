import type { Readable } from "node:stream";

export type ExportArtifactType = "audio" | "transcript" | "summary";
export type FolderExportProviderType = "filesystem";

export interface ExportProvider {
    exists(relativePath: string, expectedSize: number): Promise<boolean>;
    reconcileDirectory(
        previousPath: string | null,
        currentPath: string,
    ): Promise<{ contentPreserved: boolean }>;
    materialize(
        relativePath: string,
        content: Buffer | Readable,
    ): Promise<void>;
}

export interface FolderExportConfigurationDto {
    id: string;
    folderId: string;
    provider: FolderExportProviderType;
    targetPath: string;
    exportAudio: boolean;
    exportTranscript: boolean;
    exportSummary: boolean;
}
