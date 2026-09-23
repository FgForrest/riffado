import type { Readable } from "node:stream";
import { GoogleApiError } from "./errors";

const API_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

/** Resumable chunk size; Drive requires a multiple of 256 KiB. */
export const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;

const ITEM_FIELDS =
    "id,name,mimeType,parents,trashed,size,appProperties,driveId,capabilities(canAddChildren)";

export interface DriveItem {
    id: string;
    name: string;
    mimeType: string;
    parents: string[];
    trashed: boolean;
    /** Bytes; null for Google Docs and folders. */
    size: number | null;
    appProperties: Record<string, string>;
    driveId: string | null;
    canAddChildren: boolean;
}

export interface DriveAppProperty {
    key: string;
    value: string;
}

export interface DriveUploadInput {
    /** Replace the content of this file; create a new one when absent. */
    fileId?: string;
    /** Required to create. */
    parentId?: string;
    name: string;
    content: Buffer | Readable;
    contentType: string;
    /** Create a Google Doc from the content (Markdown, HTML, ...). */
    convertToGoogleDoc?: boolean;
    appProperties: Record<string, string>;
}

export interface DriveItemPatch {
    name?: string;
    addParents?: string;
    removeParents?: string;
    trashed?: boolean;
    appProperties?: Record<string, string>;
}

/** The Drive calls exports need, and nothing else. */
export interface DriveClient {
    /** The item, or null when it does not exist or is not visible. */
    getItem(id: string): Promise<DriveItem | null>;
    /** Every non-trashed item visible to the app carrying the property. */
    listByAppProperty(property: DriveAppProperty): Promise<DriveItem[]>;
    /** A non-trashed child of `parentId` named `name` carrying the property. */
    findChild(
        parentId: string,
        name: string,
        property: DriveAppProperty,
    ): Promise<DriveItem | null>;
    createFolder(input: {
        name: string;
        parentId: string;
        description: string;
        appProperties: Record<string, string>;
    }): Promise<DriveItem>;
    upload(input: DriveUploadInput): Promise<DriveItem>;
    updateItem(id: string, patch: DriveItemPatch): Promise<DriveItem>;
}

export interface FetchDriveClientOptions {
    getAccessToken: () => Promise<string>;
    /** Called on a 401, before the one retry with a fresh token. */
    onUnauthorized?: () => void;
    /** Shared drive the export lives in; null for My Drive. */
    driveId: string | null;
    fetchImpl?: typeof fetch;
    chunkBytes?: number;
}

interface RawDriveItem {
    id?: string;
    name?: string;
    mimeType?: string;
    parents?: string[];
    trashed?: boolean;
    size?: string;
    appProperties?: Record<string, string>;
    driveId?: string;
    capabilities?: { canAddChildren?: boolean };
}

function toItem(raw: RawDriveItem): DriveItem {
    if (!raw.id) throw new Error("Drive returned an item without an id");
    return {
        id: raw.id,
        name: raw.name ?? "",
        mimeType: raw.mimeType ?? "",
        parents: raw.parents ?? [],
        trashed: raw.trashed === true,
        size: raw.size === undefined ? null : Number(raw.size),
        appProperties: raw.appProperties ?? {},
        driveId: raw.driveId ?? null,
        canAddChildren: raw.capabilities?.canAddChildren !== false,
    };
}

/** A string literal for a Drive `q` expression. */
export function driveQueryString(value: string): string {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function appPropertyClause(property: DriveAppProperty): string {
    return `appProperties has { key=${driveQueryString(property.key)} and value=${driveQueryString(property.value)} }`;
}

async function driveError(response: Response): Promise<GoogleApiError> {
    const body = (await response.json().catch(() => null)) as {
        error?: {
            message?: string;
            status?: string;
            errors?: Array<{ reason?: string }>;
        };
    } | null;
    const reason =
        body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? null;
    return new GoogleApiError(
        response.status,
        reason,
        `Google Drive: ${body?.error?.message ?? response.statusText ?? response.status}`,
    );
}

function multipartBody(
    metadata: Record<string, unknown>,
    content: Buffer,
    contentType: string,
): { body: Buffer; contentType: string } {
    const boundary = `riffado-${crypto.randomUUID()}`;
    const head = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--`);
    return {
        body: Buffer.concat([head, content, tail]),
        contentType: `multipart/related; boundary=${boundary}`,
    };
}

/** `Range: bytes=0-N` of a 308 answer: how many bytes Drive holds. */
function persistedBytes(response: Response): number {
    const range = response.headers.get("range");
    const match = range ? /bytes=0-(\d+)/.exec(range) : null;
    return match ? Number(match[1]) + 1 : 0;
}

export class FetchDriveClient implements DriveClient {
    private readonly options: FetchDriveClientOptions;
    private readonly fetchImpl: typeof fetch;
    private readonly chunkBytes: number;

    constructor(options: FetchDriveClientOptions) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.chunkBytes = options.chunkBytes ?? RESUMABLE_CHUNK_BYTES;
    }

    private async send(
        url: string,
        init: RequestInit,
        retryUnauthorized = true,
    ): Promise<Response> {
        const token = await this.options.getAccessToken();
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        const response = await this.fetchImpl(url, { ...init, headers });
        if (response.status === 401 && retryUnauthorized) {
            this.options.onUnauthorized?.();
            return this.send(url, init, false);
        }
        return response;
    }

    private async json(url: string, init: RequestInit): Promise<RawDriveItem> {
        const response = await this.send(url, init);
        if (!response.ok) throw await driveError(response);
        return (await response.json()) as RawDriveItem;
    }

    private url(base: string, path: string, params: Record<string, string>) {
        const url = new URL(`${base}${path}`);
        url.searchParams.set("supportsAllDrives", "true");
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
        return url.toString();
    }

    private async list(q: string, pageSize: number, all: boolean) {
        const items: DriveItem[] = [];
        let pageToken: string | undefined;
        do {
            const params: Record<string, string> = {
                q,
                pageSize: String(pageSize),
                fields: `nextPageToken,files(${ITEM_FIELDS})`,
                includeItemsFromAllDrives: "true",
                ...(this.options.driveId
                    ? { corpora: "drive", driveId: this.options.driveId }
                    : { corpora: "user" }),
            };
            if (pageToken) params.pageToken = pageToken;
            const response = await this.send(
                this.url(API_BASE, "/files", params),
                { method: "GET" },
            );
            if (!response.ok) throw await driveError(response);
            const page = (await response.json()) as {
                nextPageToken?: string;
                files?: RawDriveItem[];
            };
            items.push(...(page.files ?? []).map(toItem));
            pageToken = all ? page.nextPageToken : undefined;
        } while (pageToken);
        return items;
    }

    async getItem(id: string): Promise<DriveItem | null> {
        const response = await this.send(
            this.url(API_BASE, `/files/${encodeURIComponent(id)}`, {
                fields: ITEM_FIELDS,
            }),
            { method: "GET" },
        );
        if (response.status === 404) return null;
        if (!response.ok) throw await driveError(response);
        return toItem((await response.json()) as RawDriveItem);
    }

    listByAppProperty(property: DriveAppProperty): Promise<DriveItem[]> {
        return this.list(
            `${appPropertyClause(property)} and trashed = false`,
            1000,
            true,
        );
    }

    async findChild(
        parentId: string,
        name: string,
        property: DriveAppProperty,
    ): Promise<DriveItem | null> {
        const [item] = await this.list(
            `${driveQueryString(parentId)} in parents and name = ${driveQueryString(name)} and ${appPropertyClause(property)} and trashed = false`,
            10,
            false,
        );
        return item ?? null;
    }

    async createFolder(input: {
        name: string;
        parentId: string;
        description: string;
        appProperties: Record<string, string>;
    }): Promise<DriveItem> {
        return toItem(
            await this.json(
                this.url(API_BASE, "/files", { fields: ITEM_FIELDS }),
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json; charset=UTF-8",
                    },
                    body: JSON.stringify({
                        name: input.name,
                        mimeType: DRIVE_FOLDER_MIME,
                        parents: [input.parentId],
                        description: input.description,
                        appProperties: input.appProperties,
                    }),
                },
            ),
        );
    }

    async updateItem(id: string, patch: DriveItemPatch): Promise<DriveItem> {
        const params: Record<string, string> = { fields: ITEM_FIELDS };
        if (patch.addParents) params.addParents = patch.addParents;
        if (patch.removeParents) params.removeParents = patch.removeParents;
        const body: Record<string, unknown> = {};
        if (patch.name !== undefined) body.name = patch.name;
        if (patch.trashed !== undefined) body.trashed = patch.trashed;
        if (patch.appProperties) body.appProperties = patch.appProperties;
        return toItem(
            await this.json(
                this.url(API_BASE, `/files/${encodeURIComponent(id)}`, params),
                {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json; charset=UTF-8",
                    },
                    body: JSON.stringify(body),
                },
            ),
        );
    }

    async upload(input: DriveUploadInput): Promise<DriveItem> {
        if (!input.fileId && !input.parentId) {
            throw new Error("Creating a Drive file needs a parent folder");
        }
        const metadata: Record<string, unknown> = {
            name: input.name,
            appProperties: input.appProperties,
        };
        if (!input.fileId) {
            metadata.parents = [input.parentId];
            metadata.mimeType = input.convertToGoogleDoc
                ? GOOGLE_DOC_MIME
                : input.contentType;
        }
        const path = input.fileId
            ? `/files/${encodeURIComponent(input.fileId)}`
            : "/files";
        const method = input.fileId ? "PATCH" : "POST";
        if (Buffer.isBuffer(input.content)) {
            const multipart = multipartBody(
                metadata,
                input.content,
                input.contentType,
            );
            return toItem(
                await this.json(
                    this.url(UPLOAD_BASE, path, {
                        uploadType: "multipart",
                        fields: ITEM_FIELDS,
                    }),
                    {
                        method,
                        headers: { "Content-Type": multipart.contentType },
                        body: new Uint8Array(multipart.body),
                    },
                ),
            );
        }
        const session = await this.send(
            this.url(UPLOAD_BASE, path, {
                uploadType: "resumable",
                fields: ITEM_FIELDS,
            }),
            {
                method,
                headers: {
                    "Content-Type": "application/json; charset=UTF-8",
                    "X-Upload-Content-Type": input.contentType,
                },
                body: JSON.stringify(metadata),
            },
        );
        if (!session.ok) throw await driveError(session);
        const location = session.headers.get("location");
        if (!location) {
            throw new GoogleApiError(
                502,
                null,
                "Google Drive: resumable upload returned no session",
            );
        }
        return this.uploadChunks(location, input.content);
    }

    private async uploadChunks(
        sessionUrl: string,
        stream: Readable,
    ): Promise<DriveItem> {
        let parts: Buffer[] = [];
        let pending = 0;
        let offset = 0;

        const putChunk = async (chunk: Buffer, total: number | null) => {
            const range =
                chunk.length === 0
                    ? `bytes */${total ?? 0}`
                    : `bytes ${offset}-${offset + chunk.length - 1}/${total ?? "*"}`;
            return this.send(sessionUrl, {
                method: "PUT",
                headers: { "Content-Range": range },
                body: new Uint8Array(chunk),
            });
        };

        const flush = async () => {
            const all = Buffer.concat(parts);
            const chunk = all.subarray(0, this.chunkBytes);
            const rest = all.subarray(this.chunkBytes);
            const response = await putChunk(chunk, null);
            if (response.status !== 308) {
                throw response.ok
                    ? new GoogleApiError(
                          502,
                          null,
                          "Google Drive: upload finished before its last chunk",
                      )
                    : await driveError(response);
            }
            const persisted = Math.max(persistedBytes(response), offset);
            const unsent = chunk.subarray(persisted - offset);
            offset = persisted;
            parts = unsent.length > 0 ? [unsent, rest] : [rest];
            pending = unsent.length + rest.length;
        };

        for await (const piece of stream) {
            const buffer = Buffer.isBuffer(piece)
                ? piece
                : Buffer.from(piece as Uint8Array);
            parts.push(buffer);
            pending += buffer.length;
            while (pending > this.chunkBytes) await flush();
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const last = Buffer.concat(parts);
            const response = await putChunk(last, offset + last.length);
            if (response.ok) {
                return toItem((await response.json()) as RawDriveItem);
            }
            if (response.status !== 308) throw await driveError(response);
            const persisted = Math.max(persistedBytes(response), offset);
            parts = [last.subarray(persisted - offset)];
            offset = persisted;
        }
        throw new GoogleApiError(
            502,
            null,
            "Google Drive: the upload did not complete",
        );
    }
}

export function createDriveClient(
    options: FetchDriveClientOptions,
): DriveClient {
    return new FetchDriveClient(options);
}
