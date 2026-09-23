/**
 * The Drive export provider against the real Google Drive API.
 *
 * Opt-in, never in CI: it needs an access token and a folder to work in.
 *
 *   GOOGLE_DRIVE_LIVE_ACCESS_TOKEN=ya29...   (drive or drive.file scope)
 *   GOOGLE_DRIVE_LIVE_PARENT_ID=<folder id>   (the token must be able to add to it)
 *   GOOGLE_DRIVE_LIVE_DRIVE_ID=<shared drive id>   (only for a shared drive)
 *
 * It creates one scratch folder under the parent, exercises the provider in
 * it, and moves the scratch folder to the trash at the end. It checks what
 * the in-memory fake cannot: Markdown conversion on create and on update,
 * resumable uploads, `appProperties` queries, and moves between parents.
 */

import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DriveExportProvider } from "@/lib/folder-exports/drive-provider";
import {
    FetchDriveClient,
    GOOGLE_DOC_MIME,
} from "@/lib/integrations/google/drive-client";
import { MemoryDriveNodeStore } from "@/tests/integrations/google/fake-drive";

const token = process.env.GOOGLE_DRIVE_LIVE_ACCESS_TOKEN;
const parentId = process.env.GOOGLE_DRIVE_LIVE_PARENT_ID;
const driveId = process.env.GOOGLE_DRIVE_LIVE_DRIVE_ID ?? null;
const describeLive = token && parentId ? describe : describe.skip;

describeLive("Google Drive export provider (live Drive)", () => {
    const client = new FetchDriveClient({
        getAccessToken: async () => token ?? "",
        driveId,
        // Small chunks, so a short stream still takes several requests.
        chunkBytes: 256 * 1024,
    });
    const exportId = `live-${Date.now()}`;
    const nodes = new MemoryDriveNodeStore();
    let root = "";

    function provider() {
        return new DriveExportProvider({
            exportId,
            rootFolderId: root,
            client,
            nodes,
        });
    }

    beforeAll(async () => {
        const scratch = await client.createFolder({
            name: `riffado-live-test-${new Date().toISOString()}`,
            parentId: parentId ?? "",
            description: "Scratch folder of a Riffado test; safe to delete.",
            appProperties: {},
        });
        root = scratch.id;
    }, 60_000);

    afterAll(async () => {
        if (root) await client.updateItem(root, { trashed: true });
    }, 60_000);

    it("streams audio in resumable chunks", async () => {
        const bytes = Buffer.alloc(700 * 1024, 7);
        await provider().materialize(
            `${root}/Team/Recording/audio.mp3`,
            Readable.from([
                bytes.subarray(0, 300_000),
                bytes.subarray(300_000),
            ]),
            { version: "a1", format: "file" },
        );
        expect(
            await provider().exists(`${root}/Team/Recording/audio.mp3`, {
                size: bytes.length,
                version: "a1",
                format: "file",
            }),
        ).toBe(true);
    }, 120_000);

    it("converts Markdown to a Doc, and again when it is rewritten", async () => {
        const target = `${root}/Team/Recording/riffado.summary`;
        await provider().materialize(target, Buffer.from("# First\n\n- one"), {
            version: "s1",
            format: "google_doc",
        });
        const first = await nodes.get(target);
        await provider().materialize(target, Buffer.from("# Second\n\n- two"), {
            version: "s2",
            format: "google_doc",
        });
        const second = await nodes.get(target);
        expect(second?.driveFileId).toBe(first?.driveFileId);
        const item = await client.getItem(second?.driveFileId ?? "");
        expect(item?.mimeType).toBe(GOOGLE_DOC_MIME);
        expect(item?.appProperties.riffadoVersion).toBe("s2");
    }, 120_000);

    it("finds its items by app property and moves a folder in place", async () => {
        const tagged = await client.listByAppProperty({
            key: "riffadoExport",
            value: exportId,
        });
        expect(tagged.length).toBeGreaterThanOrEqual(4);
        const planning = provider();
        await expect(
            planning.reconcileDirectory(
                `${root}/Team/Recording`,
                `${root}/Archive/Renamed`,
            ),
        ).resolves.toEqual({ contentPreserved: true });
        expect(
            await provider().exists(`${root}/Archive/Renamed/audio.mp3`, {
                size: 700 * 1024,
                version: "a1",
                format: "file",
            }),
        ).toBe(true);
    }, 120_000);

    it("trashes an empty folder it created", async () => {
        await provider().reconcileDirectory(null, `${root}/Empty`);
        const empty = await nodes.get(`${root}/Empty`);
        await expect(
            provider().removeEmptyDirectory(`${root}/Empty`),
        ).resolves.toBe(true);
        const item = await client.getItem(empty?.driveFileId ?? "");
        expect(item?.trashed).toBe(true);
    }, 120_000);
});
