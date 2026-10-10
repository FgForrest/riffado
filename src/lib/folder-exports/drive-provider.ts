import path from "node:path";
import type { Readable } from "node:stream";
import {
    DRIVE_FOLDER_MIME,
    type DriveClient,
    type DriveItem,
    GOOGLE_DOC_MIME,
} from "@/lib/integrations/google/drive-client";
import type { DriveNodeKind, DriveNodeStore } from "./drive-nodes";
import { validateRelativeExportPath } from "./filesystem-provider";
import type {
    ExpectedArtifact,
    ExportFormat,
    ExportProvider,
    MaterializeOptions,
    OwnedEntryKind,
    TakenNames,
} from "./types";

/** Drive description of every folder an export creates. */
export const MANAGED_FOLDER_DESCRIPTION =
    "Managed by Riffado. Content you add here may be removed.";
/** `appProperties` key naming the export that created an item. */
export const EXPORT_PROPERTY = "riffadoExport";
/** `appProperties` key holding the digest of a file's content. */
export const VERSION_PROPERTY = "riffadoVersion";

/** The picked folder is gone, trashed, or no longer writable. */
export class DriveTargetLostError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DriveTargetLostError";
    }
}

const CONTENT_TYPES: Record<string, string> = {
    ".aac": "audio/aac",
    ".eml": "message/rfc822",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".md": "text/markdown",
    ".mp3": "audio/mpeg",
    ".mp4": "audio/mp4",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
};

export function driveContentType(name: string, format: ExportFormat): string {
    if (format === "google_doc") return "text/markdown";
    return (
        CONTENT_TYPES[path.posix.extname(name).toLowerCase()] ??
        "application/octet-stream"
    );
}

function kindOf(format: ExportFormat): DriveNodeKind {
    return format === "google_doc" ? "google_doc" : "file";
}

function isKind(item: DriveItem, kind: DriveNodeKind): boolean {
    switch (kind) {
        case "folder":
            return item.mimeType === DRIVE_FOLDER_MIME;
        case "google_doc":
            return item.mimeType === GOOGLE_DOC_MIME;
        case "file":
            return (
                item.mimeType !== DRIVE_FOLDER_MIME &&
                item.mimeType !== GOOGLE_DOC_MIME
            );
    }
}

export interface DriveExportProviderOptions {
    exportId: string;
    rootFolderId: string;
    client: DriveClient;
    nodes: DriveNodeStore;
}

/**
 * An export into a Google Drive folder the user picked.
 *
 * Logical paths start with the picked folder's id; the rest are names.
 * Drive addresses items by id and allows duplicate names, so every item the
 * export creates is recorded in the node store and tagged with the export's
 * id, which also lets a retry find what a crashed attempt already created.
 * It trashes folders it created only while they hold none of its files, and
 * files it wrote only when the same artifact is in place elsewhere: under
 * `drive.file` it cannot see what users put there.
 */
export class DriveExportProvider implements ExportProvider {
    private readonly exportId: string;
    private readonly rootId: string;
    private readonly client: DriveClient;
    private readonly nodes: DriveNodeStore;
    private rootVerified = false;
    /** Everything tagged with the export; loaded once a plan starts. */
    private snapshot: Map<string, DriveItem> | null = null;
    /** Folders verified during this instance's life, by logical path. */
    private readonly folderIds = new Map<string, string>();

    constructor(options: DriveExportProviderOptions) {
        this.exportId = options.exportId;
        this.rootId = options.rootFolderId;
        this.client = options.client;
        this.nodes = options.nodes;
    }

    private get tag() {
        return { key: EXPORT_PROPERTY, value: this.exportId };
    }

    private segments(logicalPath: string): string[] {
        const parts = validateRelativeExportPath(logicalPath).split("/");
        if (parts[0] !== this.rootId) {
            throw new Error("Export path is outside the export's Drive folder");
        }
        return parts;
    }

    /** Whether `logicalPath` lies inside the picked folder. */
    private inRoot(logicalPath: string): boolean {
        try {
            this.segments(logicalPath);
            return true;
        } catch {
            return false;
        }
    }

    private async verifyRoot(): Promise<void> {
        if (this.rootVerified) return;
        const root = await this.client.getItem(this.rootId);
        if (!root || root.trashed) {
            throw new DriveTargetLostError(
                "The Google Drive folder of this export no longer exists or is in the trash",
            );
        }
        if (root.mimeType !== DRIVE_FOLDER_MIME) {
            throw new DriveTargetLostError(
                "The Google Drive target of this export is not a folder",
            );
        }
        if (!root.canAddChildren) {
            throw new DriveTargetLostError(
                "The connected Google account can no longer add files to the export folder",
            );
        }
        this.rootVerified = true;
        this.folderIds.set(this.rootId, this.rootId);
    }

    private async loadSnapshot(): Promise<void> {
        if (this.snapshot) return;
        const items = await this.client.listByAppProperty(this.tag);
        this.snapshot = new Map(items.map((item) => [item.id, item]));
    }

    /** The item behind `id` unless it is gone or trashed. */
    private async live(id: string): Promise<DriveItem | null> {
        if (this.snapshot) return this.snapshot.get(id) ?? null;
        const item = await this.client.getItem(id);
        return item && !item.trashed ? item : null;
    }

    private remember(item: DriveItem): void {
        this.snapshot?.set(item.id, item);
    }

    /**
     * The folder at `logicalPath` if it is still where the export left it.
     * Never creates; renames it back if someone renamed it.
     */
    private async existingFolder(logicalPath: string): Promise<string | null> {
        const known = this.folderIds.get(logicalPath);
        if (known) return known;
        const parts = this.segments(logicalPath);
        if (parts.length === 1) {
            await this.verifyRoot();
            return this.rootId;
        }
        const parentId = await this.existingFolder(
            path.posix.dirname(logicalPath),
        );
        if (!parentId) return null;
        const node = await this.nodes.get(logicalPath);
        if (!node || node.kind !== "folder") return null;
        const item = await this.live(node.driveFileId);
        if (
            !item ||
            !isKind(item, "folder") ||
            !item.parents.includes(parentId)
        ) {
            await this.nodes.removeSubtree(logicalPath);
            return null;
        }
        const name = parts[parts.length - 1] ?? "";
        if (item.name !== name) {
            this.remember(await this.client.updateItem(item.id, { name }));
        }
        this.folderIds.set(logicalPath, item.id);
        return item.id;
    }

    /** A tagged child the node store lost track of: a crashed attempt's. */
    private async findTagged(
        parentId: string,
        name: string,
        kind: DriveNodeKind,
    ): Promise<DriveItem | null> {
        if (this.snapshot) {
            for (const item of this.snapshot.values()) {
                if (
                    item.name === name &&
                    item.parents.includes(parentId) &&
                    isKind(item, kind)
                ) {
                    return item;
                }
            }
            return null;
        }
        const item = await this.client.findChild(parentId, name, this.tag);
        return item && isKind(item, kind) ? item : null;
    }

    private async ensureFolder(
        logicalPath: string,
    ): Promise<{ id: string; created: boolean }> {
        const existing = await this.existingFolder(logicalPath);
        if (existing) return { id: existing, created: false };
        const parent = await this.ensureFolder(path.posix.dirname(logicalPath));
        const name = path.posix.basename(logicalPath);
        let item = await this.findTagged(parent.id, name, "folder");
        let created = false;
        if (!item) {
            item = await this.client.createFolder({
                name,
                parentId: parent.id,
                description: MANAGED_FOLDER_DESCRIPTION,
                appProperties: { [EXPORT_PROPERTY]: this.exportId },
            });
            created = true;
            this.remember(item);
        }
        await this.nodes.put({
            logicalPath,
            driveFileId: item.id,
            kind: "folder",
        });
        this.folderIds.set(logicalPath, item.id);
        return { id: item.id, created };
    }

    async reconcileDirectory(
        previousPath: string | null,
        currentPath: string,
    ): Promise<{ contentPreserved: boolean }> {
        await this.verifyRoot();
        await this.loadSnapshot();
        const parts = this.segments(currentPath);
        if (parts.length === 1) return { contentPreserved: true };

        if (previousPath && previousPath !== currentPath) {
            this.segments(previousPath);
            const previous = await this.nodes.get(previousPath);
            const item =
                previous?.kind === "folder"
                    ? await this.live(previous.driveFileId)
                    : null;
            if (item && isKind(item, "folder")) {
                if (await this.existingFolder(currentPath)) {
                    return { contentPreserved: false };
                }
                const parent = await this.ensureFolder(
                    path.posix.dirname(currentPath),
                );
                const moving = !item.parents.includes(parent.id);
                this.remember(
                    await this.client.updateItem(item.id, {
                        name: path.posix.basename(currentPath),
                        ...(moving
                            ? {
                                  addParents: parent.id,
                                  removeParents: item.parents.join(","),
                              }
                            : {}),
                    }),
                );
                await this.nodes.movePrefix(previousPath, currentPath);
                this.folderIds.clear();
                return { contentPreserved: true };
            }
            if (previous) await this.nodes.removeSubtree(previousPath);
            await this.ensureFolder(currentPath);
            return { contentPreserved: false };
        }

        const ensured = await this.ensureFolder(currentPath);
        return { contentPreserved: !ensured.created };
    }

    async takenNames(relativePath: string): Promise<TakenNames> {
        await this.loadSnapshot();
        const prefix = `${relativePath}/`;
        const names = new Set<string>();
        for (const node of await this.nodes.list()) {
            const name = node.logicalPath.slice(prefix.length);
            if (
                node.logicalPath.startsWith(prefix) &&
                !name.includes("/") &&
                (await this.live(node.driveFileId))
            ) {
                names.add(name);
            }
        }
        // Under `drive.file` the export sees only what it created.
        return { names, foreign: new Set() };
    }

    async moveFile(from: string, to: string): Promise<boolean> {
        if (!this.inRoot(from) || !this.inRoot(to)) return false;
        if (this.segments(to).length < 2) return false;
        await this.verifyRoot();
        await this.loadSnapshot();
        const node = await this.nodes.get(from);
        if (!node || node.kind === "folder") return false;
        const item = await this.live(node.driveFileId);
        if (!item || item.appProperties[EXPORT_PROPERTY] !== this.exportId) {
            return false;
        }
        const occupant = await this.nodes.get(to);
        if (occupant && (await this.live(occupant.driveFileId))) return false;
        const parent = await this.ensureFolder(path.posix.dirname(to));
        const moving = !item.parents.includes(parent.id);
        this.remember(
            await this.client.updateItem(item.id, {
                name: path.posix.basename(to),
                ...(moving
                    ? {
                          addParents: parent.id,
                          removeParents: item.parents.join(","),
                      }
                    : {}),
            }),
        );
        await this.nodes.removeSubtree(from);
        await this.nodes.put({
            logicalPath: to,
            driveFileId: item.id,
            kind: node.kind,
        });
        return true;
    }

    async removeFile(
        relativePath: string,
        options: { duplicate: boolean },
    ): Promise<boolean> {
        if (!options.duplicate || !this.inRoot(relativePath)) return false;
        const node = await this.nodes.get(relativePath);
        if (!node || node.kind === "folder") return false;
        const item = await this.live(node.driveFileId);
        await this.nodes.removeSubtree(relativePath);
        if (!item || item.appProperties[EXPORT_PROPERTY] !== this.exportId) {
            return false;
        }
        await this.client.updateItem(item.id, { trashed: true });
        this.snapshot?.delete(item.id);
        return true;
    }

    async ownedEntries(): Promise<Map<string, OwnedEntryKind>> {
        return new Map(
            (await this.nodes.list()).map((node) => [
                node.logicalPath,
                node.kind === "folder" ? "directory" : "file",
            ]),
        );
    }

    async forgetMissing(): Promise<void> {
        await this.verifyRoot();
        await this.loadSnapshot();
        for (const node of await this.nodes.list()) {
            if (!(await this.live(node.driveFileId))) {
                await this.nodes.removeSubtree(node.logicalPath);
            }
        }
        this.folderIds.clear();
    }

    async adopt(): Promise<void> {}

    async exists(
        relativePath: string,
        expected: ExpectedArtifact,
    ): Promise<boolean> {
        if (!this.inRoot(relativePath)) return false;
        const parts = this.segments(relativePath);
        if (parts.length < 2) return false;
        await this.verifyRoot();
        const parentId = await this.existingFolder(
            path.posix.dirname(relativePath),
        );
        if (!parentId) return false;
        const node = await this.nodes.get(relativePath);
        if (!node) return false;
        const item = await this.live(node.driveFileId);
        if (!item || !item.parents.includes(parentId)) return false;
        const version = item.appProperties[VERSION_PROPERTY];
        if (expected.format === "google_doc") {
            return isKind(item, "google_doc") && version === expected.version;
        }
        return (
            isKind(item, "file") &&
            item.size === expected.size &&
            (version === undefined || version === expected.version)
        );
    }

    async removeEmptyDirectory(relativePath: string): Promise<boolean> {
        if (!this.inRoot(relativePath)) return false;
        if (this.segments(relativePath).length < 2) return false;
        const node = await this.nodes.get(relativePath);
        if (!node || node.kind !== "folder") return false;
        if (await this.nodes.hasFilesUnder(relativePath)) return false;
        const item = await this.live(node.driveFileId);
        if (!item || item.appProperties[EXPORT_PROPERTY] !== this.exportId) {
            await this.nodes.removeSubtree(relativePath);
            return false;
        }
        await this.client.updateItem(item.id, { trashed: true });
        this.snapshot?.delete(item.id);
        await this.nodes.removeSubtree(relativePath);
        this.folderIds.clear();
        return true;
    }

    async materialize(
        relativePath: string,
        content: Buffer | Readable,
        options: MaterializeOptions,
    ): Promise<void> {
        const parts = this.segments(relativePath);
        if (parts.length < 2) throw new Error("Export path needs a filename");
        await this.verifyRoot();
        const parent = await this.ensureFolder(
            path.posix.dirname(relativePath),
        );
        const name = path.posix.basename(relativePath);
        const kind = kindOf(options.format);
        let fileId: string | undefined;
        const node = await this.nodes.get(relativePath);
        if (node) {
            const item = await this.live(node.driveFileId);
            if (item?.parents.includes(parent.id) && isKind(item, kind)) {
                fileId = item.id;
            } else {
                await this.nodes.removeSubtree(relativePath);
            }
        }
        fileId ??= (await this.findTagged(parent.id, name, kind))?.id;
        const item = await this.client.upload({
            fileId,
            parentId: parent.id,
            name,
            content,
            contentType: driveContentType(name, options.format),
            convertToGoogleDoc: kind === "google_doc",
            appProperties: {
                [EXPORT_PROPERTY]: this.exportId,
                [VERSION_PROPERTY]: options.version,
            },
        });
        this.remember(item);
        await this.nodes.put({
            logicalPath: relativePath,
            driveFileId: item.id,
            kind,
        });
    }
}
