import type { Readable } from "node:stream";
import type {
    DriveNode,
    DriveNodeStore,
} from "@/lib/folder-exports/drive-nodes";
import {
    DRIVE_FOLDER_MIME,
    type DriveAppProperty,
    type DriveClient,
    type DriveItem,
    type DriveItemPatch,
    type DriveUploadInput,
    GOOGLE_DOC_MIME,
} from "@/lib/integrations/google/drive-client";
import { GoogleApiError } from "@/lib/integrations/google/errors";

interface StoredItem {
    id: string;
    name: string;
    mimeType: string;
    parents: string[];
    explicitlyTrashed: boolean;
    appProperties: Record<string, string>;
    description: string | null;
    content: Buffer | null;
    canAddChildren: boolean;
}

async function readAll(content: Buffer | Readable): Promise<Buffer> {
    if (Buffer.isBuffer(content)) return content;
    const parts: Buffer[] = [];
    for await (const piece of content) {
        parts.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece));
    }
    return Buffer.concat(parts);
}

/**
 * Google Drive as far as exports can tell: ids, duplicate names, parents,
 * trash that cascades to children, app properties, and Docs conversion.
 */
export class FakeDrive implements DriveClient {
    readonly items = new Map<string, StoredItem>();
    readonly calls: string[] = [];
    private nextId = 1;
    /** Makes the next call of this name fail once with this error. */
    failNext: { call: string; error: Error } | null = null;

    private id(): string {
        const id = `item${this.nextId}`;
        this.nextId += 1;
        return id;
    }

    private record(call: string): void {
        this.calls.push(call);
        if (this.failNext?.call === call) {
            const { error } = this.failNext;
            this.failNext = null;
            throw error;
        }
    }

    addRoot(id: string, name: string, canAddChildren = true): void {
        this.items.set(id, {
            id,
            name,
            mimeType: DRIVE_FOLDER_MIME,
            parents: ["my-drive"],
            explicitlyTrashed: false,
            appProperties: {},
            description: null,
            content: null,
            canAddChildren,
        });
    }

    /** A file a person put there; the app did not create it. */
    userAddFile(parentId: string, name: string): string {
        const id = this.id();
        this.items.set(id, {
            id,
            name,
            mimeType: "text/plain",
            parents: [parentId],
            explicitlyTrashed: false,
            appProperties: {},
            description: null,
            content: Buffer.from("mine"),
            canAddChildren: false,
        });
        return id;
    }

    isTrashed(id: string): boolean {
        let current = this.items.get(id);
        while (current) {
            if (current.explicitlyTrashed) return true;
            current = this.items.get(current.parents[0] ?? "");
        }
        return false;
    }

    private view(item: StoredItem): DriveItem {
        return {
            id: item.id,
            name: item.name,
            mimeType: item.mimeType,
            parents: [...item.parents],
            trashed: this.isTrashed(item.id),
            size:
                item.content &&
                item.mimeType !== GOOGLE_DOC_MIME &&
                item.mimeType !== DRIVE_FOLDER_MIME
                    ? item.content.length
                    : null,
            appProperties: { ...item.appProperties },
            driveId: null,
            canAddChildren: item.canAddChildren,
        };
    }

    private requireParent(parentId: string | undefined): StoredItem {
        const parent = parentId ? this.items.get(parentId) : undefined;
        if (!parent || parent.mimeType !== DRIVE_FOLDER_MIME) {
            throw new GoogleApiError(404, "notFound", "File not found");
        }
        return parent;
    }

    async getItem(id: string): Promise<DriveItem | null> {
        this.record("getItem");
        const item = this.items.get(id);
        return item ? this.view(item) : null;
    }

    async listByAppProperty(property: DriveAppProperty): Promise<DriveItem[]> {
        this.record("listByAppProperty");
        return [...this.items.values()]
            .filter(
                (item) =>
                    item.appProperties[property.key] === property.value &&
                    !this.isTrashed(item.id),
            )
            .map((item) => this.view(item));
    }

    async findChild(
        parentId: string,
        name: string,
        property: DriveAppProperty,
    ): Promise<DriveItem | null> {
        this.record("findChild");
        const item = [...this.items.values()].find(
            (candidate) =>
                candidate.parents.includes(parentId) &&
                candidate.name === name &&
                candidate.appProperties[property.key] === property.value &&
                !this.isTrashed(candidate.id),
        );
        return item ? this.view(item) : null;
    }

    async createFolder(input: {
        name: string;
        parentId: string;
        description: string;
        appProperties: Record<string, string>;
    }): Promise<DriveItem> {
        this.record("createFolder");
        this.requireParent(input.parentId);
        const item: StoredItem = {
            id: this.id(),
            name: input.name,
            mimeType: DRIVE_FOLDER_MIME,
            parents: [input.parentId],
            explicitlyTrashed: false,
            appProperties: { ...input.appProperties },
            description: input.description,
            content: null,
            canAddChildren: true,
        };
        this.items.set(item.id, item);
        return this.view(item);
    }

    async upload(input: DriveUploadInput): Promise<DriveItem> {
        this.record("upload");
        const content = await readAll(input.content);
        if (input.fileId) {
            const item = this.items.get(input.fileId);
            if (!item) throw new GoogleApiError(404, "notFound", "not found");
            item.name = input.name;
            item.content = content;
            item.appProperties = {
                ...item.appProperties,
                ...input.appProperties,
            };
            return this.view(item);
        }
        this.requireParent(input.parentId);
        const item: StoredItem = {
            id: this.id(),
            name: input.name,
            mimeType: input.convertToGoogleDoc
                ? GOOGLE_DOC_MIME
                : input.contentType,
            parents: [input.parentId ?? ""],
            explicitlyTrashed: false,
            appProperties: { ...input.appProperties },
            description: null,
            content,
            canAddChildren: false,
        };
        this.items.set(item.id, item);
        return this.view(item);
    }

    async updateItem(id: string, patch: DriveItemPatch): Promise<DriveItem> {
        this.record("updateItem");
        const item = this.items.get(id);
        if (!item) throw new GoogleApiError(404, "notFound", "not found");
        if (patch.name !== undefined) item.name = patch.name;
        if (patch.trashed !== undefined) item.explicitlyTrashed = patch.trashed;
        if (patch.removeParents) {
            const removed = new Set(patch.removeParents.split(","));
            item.parents = item.parents.filter(
                (parent) => !removed.has(parent),
            );
        }
        if (patch.addParents) {
            this.requireParent(patch.addParents);
            item.parents.push(patch.addParents);
        }
        if (patch.appProperties) {
            item.appProperties = {
                ...item.appProperties,
                ...patch.appProperties,
            };
        }
        return this.view(item);
    }

    /**
     * Everything under `rootId` that is not in the trash, as sorted paths;
     * folders end in `/`, Google Docs in ` [doc]`.
     */
    tree(rootId: string): string[] {
        const paths: string[] = [];
        const walk = (parentId: string, prefix: string) => {
            for (const item of this.items.values()) {
                if (!item.parents.includes(parentId) || item.explicitlyTrashed)
                    continue;
                const itemPath = `${prefix}${item.name}`;
                if (item.mimeType === DRIVE_FOLDER_MIME) {
                    paths.push(`${itemPath}/`);
                    walk(item.id, `${itemPath}/`);
                } else if (item.mimeType === GOOGLE_DOC_MIME) {
                    paths.push(`${itemPath} [doc]`);
                } else {
                    paths.push(itemPath);
                }
            }
        };
        walk(rootId, "");
        return paths.sort();
    }

    /** The content of the item at `relative` under `rootId`. */
    contentAt(rootId: string, relative: string): string | null {
        let parentId = rootId;
        const parts = relative.split("/");
        for (const [index, name] of parts.entries()) {
            const item = [...this.items.values()].find(
                (candidate) =>
                    candidate.parents.includes(parentId) &&
                    candidate.name === name &&
                    !candidate.explicitlyTrashed,
            );
            if (!item) return null;
            if (index === parts.length - 1) {
                return item.content?.toString("utf8") ?? null;
            }
            parentId = item.id;
        }
        return null;
    }

    idAt(rootId: string, relative: string): string | null {
        let parentId = rootId;
        for (const name of relative.split("/")) {
            const item = [...this.items.values()].find(
                (candidate) =>
                    candidate.parents.includes(parentId) &&
                    candidate.name === name &&
                    !candidate.explicitlyTrashed,
            );
            if (!item) return null;
            parentId = item.id;
        }
        return parentId;
    }
}

/** The node store, in memory, for tests that need no database. */
export class MemoryDriveNodeStore implements DriveNodeStore {
    readonly nodes = new Map<string, DriveNode>();

    async get(logicalPath: string): Promise<DriveNode | null> {
        return this.nodes.get(logicalPath) ?? null;
    }

    async put(node: DriveNode): Promise<void> {
        this.nodes.set(node.logicalPath, { ...node });
    }

    async removeSubtree(logicalPath: string): Promise<void> {
        for (const key of [...this.nodes.keys()]) {
            if (key === logicalPath || key.startsWith(`${logicalPath}/`)) {
                this.nodes.delete(key);
            }
        }
    }

    async movePrefix(previous: string, current: string): Promise<void> {
        const moved = [...this.nodes.values()].filter(
            (node) =>
                node.logicalPath === previous ||
                node.logicalPath.startsWith(`${previous}/`),
        );
        for (const node of moved) this.nodes.delete(node.logicalPath);
        for (const node of moved) {
            const logicalPath = `${current}${node.logicalPath.slice(previous.length)}`;
            this.nodes.set(logicalPath, { ...node, logicalPath });
        }
    }

    async hasFilesUnder(logicalPath: string): Promise<boolean> {
        return [...this.nodes.values()].some(
            (node) =>
                node.kind !== "folder" &&
                node.logicalPath.startsWith(`${logicalPath}/`),
        );
    }
}
