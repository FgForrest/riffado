export type FolderKind = "private" | "public" | "custom";

export interface RecordingFolder {
    id: string;
    parentId: string | null;
    name: string;
    kind: FolderKind;
}

export interface RecordingFolderAssignment {
    recordingId: string;
    folderId: string;
}

export interface FolderOrganization {
    folders: RecordingFolder[];
    assignments: RecordingFolderAssignment[];
}
