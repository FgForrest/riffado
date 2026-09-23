import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
    driveQueryString,
    FetchDriveClient,
    GOOGLE_DOC_MIME,
} from "@/lib/integrations/google/drive-client";
import { GoogleApiError } from "@/lib/integrations/google/errors";

interface Captured {
    url: URL;
    method: string;
    headers: Headers;
    body: Buffer;
}

function capture(input: RequestInfo | URL, init?: RequestInit): Captured {
    const body = init?.body;
    return {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body:
            body instanceof Uint8Array
                ? Buffer.from(body)
                : Buffer.from(typeof body === "string" ? body : ""),
    };
}

function json(value: unknown, status = 200, headers: HeadersInit = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });
}

const ITEM = {
    id: "file1",
    name: "audio.mp3",
    mimeType: "audio/mpeg",
    parents: ["folder1"],
    size: "12",
    appProperties: { riffadoExport: "e1" },
};

function client(
    respond: (request: Captured, index: number) => Response,
    options: { chunkBytes?: number; driveId?: string | null } = {},
) {
    const requests: Captured[] = [];
    const fetchImpl = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = capture(input, init);
            requests.push(request);
            return respond(request, requests.length - 1);
        },
    );
    const onUnauthorized = vi.fn();
    let token = 0;
    const drive = new FetchDriveClient({
        getAccessToken: async () => {
            token += 1;
            return `token-${token}`;
        },
        onUnauthorized,
        driveId: options.driveId ?? null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        chunkBytes: options.chunkBytes,
    });
    return { drive, requests, onUnauthorized };
}

describe("Google Drive HTTP client", () => {
    it("quotes query strings", () => {
        expect(driveQueryString("O'Brien \\ notes")).toBe(
            "'O\\'Brien \\\\ notes'",
        );
    });

    it("reads an item, and a missing one as null", async () => {
        const { drive, requests } = client((request) =>
            request.url.pathname.endsWith("/missing")
                ? json({ error: { message: "not found" } }, 404)
                : json(ITEM),
        );
        await expect(drive.getItem("file1")).resolves.toMatchObject({
            id: "file1",
            size: 12,
            trashed: false,
            canAddChildren: true,
        });
        await expect(drive.getItem("missing")).resolves.toBeNull();
        expect(requests[0]?.url.searchParams.get("supportsAllDrives")).toBe(
            "true",
        );
        expect(requests[0]?.headers.get("authorization")).toBe(
            "Bearer token-1",
        );
    });

    it("lists by app property across pages, in the shared drive", async () => {
        const { drive, requests } = client((_request, index) =>
            index === 0
                ? json({ nextPageToken: "p2", files: [ITEM] })
                : json({ files: [{ ...ITEM, id: "file2" }] }),
        );
        const items = await drive.listByAppProperty({
            key: "riffadoExport",
            value: "e1",
        });
        expect(items.map((item) => item.id)).toEqual(["file1", "file2"]);
        const first = requests[0]?.url.searchParams;
        expect(first?.get("q")).toBe(
            "appProperties has { key='riffadoExport' and value='e1' } and trashed = false",
        );
        expect(first?.get("corpora")).toBe("user");
        expect(requests[1]?.url.searchParams.get("pageToken")).toBe("p2");
        const shared = client(() => json({ files: [] }), { driveId: "d1" });
        await shared.drive.listByAppProperty({ key: "k", value: "v" });
        expect(shared.requests[0]?.url.searchParams.get("corpora")).toBe(
            "drive",
        );
        expect(shared.requests[0]?.url.searchParams.get("driveId")).toBe("d1");
    });

    it("finds a child by parent, name and tag", async () => {
        const { drive, requests } = client(() => json({ files: [ITEM] }));
        await drive.findChild("folder1", "it's.md", {
            key: "riffadoExport",
            value: "e1",
        });
        expect(requests[0]?.url.searchParams.get("q")).toBe(
            "'folder1' in parents and name = 'it\\'s.md' and appProperties has { key='riffadoExport' and value='e1' } and trashed = false",
        );
    });

    it("uploads a buffer as one multipart request, converting to a Doc", async () => {
        const { drive, requests } = client(() =>
            json({ ...ITEM, mimeType: GOOGLE_DOC_MIME }),
        );
        await drive.upload({
            parentId: "folder1",
            name: "riffado.summary",
            content: Buffer.from("# Title"),
            contentType: "text/markdown",
            convertToGoogleDoc: true,
            appProperties: { riffadoExport: "e1" },
        });
        const request = requests[0];
        expect(request?.method).toBe("POST");
        expect(request?.url.pathname).toBe("/upload/drive/v3/files");
        expect(request?.url.searchParams.get("uploadType")).toBe("multipart");
        const body = request?.body.toString("utf8") ?? "";
        expect(body).toContain(`"mimeType":"${GOOGLE_DOC_MIME}"`);
        expect(body).toContain('"parents":["folder1"]');
        expect(body).toContain("Content-Type: text/markdown\r\n\r\n# Title");
    });

    it("updates the content of an existing file without touching its parents", async () => {
        const { drive, requests } = client(() => json(ITEM));
        await drive.upload({
            fileId: "file1",
            name: "audio.mp3",
            content: Buffer.from("x"),
            contentType: "audio/mpeg",
            appProperties: { riffadoVersion: "v2" },
        });
        expect(requests[0]?.method).toBe("PATCH");
        expect(requests[0]?.url.pathname).toBe("/upload/drive/v3/files/file1");
        const body = requests[0]?.body.toString("utf8") ?? "";
        expect(body).not.toContain("parents");
        expect(body).not.toContain("mimeType");
    });

    it("streams in chunks and resends what Drive did not keep", async () => {
        const chunkBytes = 4;
        const { drive, requests } = client(
            (request, index) => {
                if (index === 0) {
                    return new Response(null, {
                        status: 200,
                        headers: { Location: "https://upload.example/s1" },
                    });
                }
                const range = request.headers.get("content-range") ?? "";
                if (range.endsWith("/*")) {
                    // Keeps only three of the four bytes of the first chunk.
                    return new Response(null, {
                        status: 308,
                        headers: {
                            Range:
                                range === "bytes 0-3/*"
                                    ? "bytes=0-2"
                                    : `bytes=0-${range.split(/[ -/]/)[2]}`,
                        },
                    });
                }
                return json(ITEM);
            },
            { chunkBytes },
        );
        await drive.upload({
            parentId: "folder1",
            name: "audio.mp3",
            content: Readable.from([
                Buffer.from("abcdef"),
                Buffer.from("ghij"),
            ]),
            contentType: "audio/mpeg",
            appProperties: {},
        });
        const init = requests[0];
        expect(init?.url.searchParams.get("uploadType")).toBe("resumable");
        expect(init?.headers.get("x-upload-content-type")).toBe("audio/mpeg");
        const chunks = requests.slice(1).map((request) => ({
            range: request.headers.get("content-range"),
            body: request.body.toString("utf8"),
        }));
        expect(chunks).toEqual([
            { range: "bytes 0-3/*", body: "abcd" },
            { range: "bytes 3-6/*", body: "defg" },
            { range: "bytes 7-9/10", body: "hij" },
        ]);
    });

    it("finishes an empty stream", async () => {
        const { drive, requests } = client((_request, index) =>
            index === 0
                ? new Response(null, {
                      status: 200,
                      headers: { Location: "https://upload.example/s1" },
                  })
                : json(ITEM),
        );
        await drive.upload({
            parentId: "folder1",
            name: "empty.mp3",
            content: Readable.from([]),
            contentType: "audio/mpeg",
            appProperties: {},
        });
        expect(requests[1]?.headers.get("content-range")).toBe("bytes */0");
    });

    it("retries once with a fresh token after a 401", async () => {
        const { drive, requests, onUnauthorized } = client((_request, index) =>
            index === 0
                ? json({ error: { message: "expired" } }, 401)
                : json(ITEM),
        );
        await expect(drive.getItem("file1")).resolves.toMatchObject({
            id: "file1",
        });
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        expect(requests[1]?.headers.get("authorization")).toBe(
            "Bearer token-2",
        );
    });

    it("maps Drive errors to retryable and permanent ones", async () => {
        const { drive } = client(() =>
            json(
                {
                    error: {
                        message: "Rate limit",
                        errors: [{ reason: "userRateLimitExceeded" }],
                    },
                },
                403,
            ),
        );
        const limited = await drive
            .createFolder({
                name: "x",
                parentId: "p",
                description: "d",
                appProperties: {},
            })
            .catch((error: unknown) => error);
        expect(limited).toBeInstanceOf(GoogleApiError);
        expect((limited as GoogleApiError).retryable).toBe(true);
        expect(
            new GoogleApiError(403, "insufficientFilePermissions", "no")
                .retryable,
        ).toBe(false);
        expect(new GoogleApiError(503, null, "down").retryable).toBe(true);
        expect(new GoogleApiError(404, "notFound", "gone").retryable).toBe(
            false,
        );
    });

    it("moves and trashes through a metadata update", async () => {
        const { drive, requests } = client(() => json(ITEM));
        await drive.updateItem("file1", {
            name: "new",
            addParents: "b",
            removeParents: "a",
            trashed: true,
        });
        const request = requests[0];
        expect(request?.method).toBe("PATCH");
        expect(request?.url.searchParams.get("addParents")).toBe("b");
        expect(request?.url.searchParams.get("removeParents")).toBe("a");
        expect(JSON.parse(request?.body.toString("utf8") ?? "{}")).toEqual({
            name: "new",
            trashed: true,
        });
    });
});
