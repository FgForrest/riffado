export type FolderKind = "private" | "public" | "custom";

/** `personal` folders belong to their owner; `org` folders to the Organization. */
export type FolderScope = "personal" | "org";

export interface RecordingFolder {
    id: string;
    parentId: string | null;
    name: string;
    kind: FolderKind;
    sortOrder: number;
    scope: FolderScope;
    /** Optimistic-lock version; sent back on rename and move. */
    version: number;
}

export interface RecordingFolderAssignment {
    recordingId: string;
    folderId: string;
}

export interface FolderOrganization {
    folders: RecordingFolder[];
    assignments: RecordingFolderAssignment[];
}
