import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import {
    DriveExportProvider,
    DriveTargetLostError,
    driveContentType,
    EXPORT_PROPERTY,
    MANAGED_FOLDER_DESCRIPTION,
    VERSION_PROPERTY,
} from "@/lib/folder-exports/drive-provider";
import { documentFiles } from "@/lib/folder-exports/naming";
import { GOOGLE_DOC_MIME } from "@/lib/integrations/google/drive-client";
import {
    FakeDrive,
    MemoryDriveNodeStore,
} from "@/tests/integrations/google/fake-drive";

const ROOT = "rootfolder1";
const EXPORT = "export-1";

describe("Google Drive export provider", () => {
    let drive: FakeDrive;
    let nodes: MemoryDriveNodeStore;

    function provider() {
        return new DriveExportProvider({
            exportId: EXPORT,
            rootFolderId: ROOT,
            client: drive,
            nodes,
        });
    }

    const file = (version = "v1") => ({ version, format: "file" as const });

    beforeEach(() => {
        drive = new FakeDrive();
        drive.addRoot(ROOT, "Exports");
        nodes = new MemoryDriveNodeStore();
    });

    it("creates tagged folders along the path and writes the file", async () => {
        await provider().materialize(
            `${ROOT}/Team/Weekly/riffado.transcript.md`,
            Buffer.from("hello"),
            file(),
        );
        expect(drive.tree(ROOT)).toEqual([
            "Team/",
            "Team/Weekly/",
            "Team/Weekly/riffado.transcript.md",
        ]);
        const folder = drive.items.get(drive.idAt(ROOT, "Team") ?? "");
        expect(folder?.description).toBe(MANAGED_FOLDER_DESCRIPTION);
        expect(folder?.appProperties[EXPORT_PROPERTY]).toBe(EXPORT);
        const written = drive.items.get(
            drive.idAt(ROOT, "Team/Weekly/riffado.transcript.md") ?? "",
        );
        expect(written?.mimeType).toBe("text/markdown");
        expect(written?.appProperties).toEqual({
            [EXPORT_PROPERTY]: EXPORT,
            [VERSION_PROPERTY]: "v1",
        });
    });

    it("rewrites the same file rather than adding a second one", async () => {
        const target = `${ROOT}/Team/audio.mp3`;
        await provider().materialize(target, Buffer.from("one"), file("v1"));
        const firstId = drive.idAt(ROOT, "Team/audio.mp3");
        await provider().materialize(
            target,
            Readable.from([Buffer.from("tw"), Buffer.from("o!")]),
            file("v2"),
        );
        expect(drive.tree(ROOT)).toEqual(["Team/", "Team/audio.mp3"]);
        expect(drive.idAt(ROOT, "Team/audio.mp3")).toBe(firstId);
        expect(drive.contentAt(ROOT, "Team/audio.mp3")).toBe("two!");
        expect(
            await provider().exists(target, {
                size: 4,
                version: "v2",
                format: "file",
            }),
        ).toBe(true);
    });

    it("writes a Google Doc and checks it by version, not size", async () => {
        const target = `${ROOT}/Team/riffado.summary`;
        await provider().materialize(target, Buffer.from("# Summary"), {
            version: "v1",
            format: "google_doc",
        });
        expect(drive.tree(ROOT)).toEqual([
            "Team/",
            "Team/riffado.summary [doc]",
        ]);
        const expected = { size: 9, format: "google_doc" as const };
        expect(
            await provider().exists(target, { ...expected, version: "v1" }),
        ).toBe(true);
        expect(
            await provider().exists(target, { ...expected, version: "v2" }),
        ).toBe(false);
        const id = drive.idAt(ROOT, "Team/riffado.summary");
        await provider().materialize(target, Buffer.from("# New"), {
            version: "v2",
            format: "google_doc",
        });
        expect(drive.idAt(ROOT, "Team/riffado.summary")).toBe(id);
        expect(drive.items.get(id ?? "")?.mimeType).toBe(GOOGLE_DOC_MIME);
    });

    it("renames and moves a folder in place, keeping its files", async () => {
        await provider().materialize(
            `${ROOT}/Team/Old title/audio.mp3`,
            Buffer.from("abc"),
            file(),
        );
        const folderId = drive.idAt(ROOT, "Team/Old title");
        await expect(
            provider().reconcileDirectory(
                `${ROOT}/Team/Old title`,
                `${ROOT}/Archive/New title`,
            ),
        ).resolves.toEqual({ contentPreserved: true });
        expect(drive.tree(ROOT)).toEqual([
            "Archive/",
            "Archive/New title/",
            "Archive/New title/audio.mp3",
            "Team/",
        ]);
        expect(drive.idAt(ROOT, "Archive/New title")).toBe(folderId);
        expect([...nodes.nodes.keys()].sort()).toEqual([
            `${ROOT}/Archive`,
            `${ROOT}/Archive/New title`,
            `${ROOT}/Archive/New title/audio.mp3`,
            `${ROOT}/Team`,
        ]);
        expect(
            await provider().exists(`${ROOT}/Archive/New title/audio.mp3`, {
                size: 3,
                version: "v1",
                format: "file",
            }),
        ).toBe(true);
    });

    it("refuses to rename over a folder that is still there", async () => {
        const p = provider();
        await p.reconcileDirectory(null, `${ROOT}/One`);
        await p.reconcileDirectory(null, `${ROOT}/Two`);
        await expect(
            provider().reconcileDirectory(`${ROOT}/One`, `${ROOT}/Two`),
        ).rejects.toThrow(/over an existing directory/);
    });

    it("creates the new folder when the previous one is gone", async () => {
        await expect(
            provider().reconcileDirectory(`${ROOT}/Missing`, `${ROOT}/Fresh`),
        ).resolves.toEqual({ contentPreserved: false });
        expect(drive.tree(ROOT)).toEqual(["Fresh/"]);
    });

    it("recreates a folder someone trashed and reports its content lost", async () => {
        const target = `${ROOT}/Team/Recording/audio.mp3`;
        await provider().materialize(target, Buffer.from("abc"), file());
        await drive.updateItem(drive.idAt(ROOT, "Team") ?? "", {
            trashed: true,
        });
        expect(
            await provider().exists(target, {
                size: 3,
                version: "v1",
                format: "file",
            }),
        ).toBe(false);
        await expect(
            provider().reconcileDirectory(
                `${ROOT}/Team/Recording`,
                `${ROOT}/Team/Recording`,
            ),
        ).resolves.toEqual({ contentPreserved: false });
        await provider().materialize(target, Buffer.from("abc"), file());
        expect(drive.tree(ROOT)).toEqual([
            "Team/",
            "Team/Recording/",
            "Team/Recording/audio.mp3",
        ]);
    });

    it("renames a managed folder back when someone renamed it", async () => {
        await provider().reconcileDirectory(null, `${ROOT}/Team`);
        await drive.updateItem(drive.idAt(ROOT, "Team") ?? "", {
            name: "Mine now",
        });
        await expect(
            provider().reconcileDirectory(null, `${ROOT}/Team`),
        ).resolves.toEqual({ contentPreserved: true });
        expect(drive.tree(ROOT)).toEqual(["Team/"]);
    });

    it("finds what a crashed attempt created instead of duplicating it", async () => {
        const target = `${ROOT}/Team/audio.mp3`;
        await provider().materialize(target, Buffer.from("one"), file());
        // The upload landed; recording its id did not.
        nodes.nodes.clear();
        await provider().materialize(target, Buffer.from("two"), file("v2"));
        expect(drive.tree(ROOT)).toEqual(["Team/", "Team/audio.mp3"]);
        expect(drive.contentAt(ROOT, "Team/audio.mp3")).toBe("two");
    });

    it("trashes only empty folders it created, never the root", async () => {
        const p = provider();
        await p.reconcileDirectory(null, `${ROOT}/Empty`);
        await p.materialize(
            `${ROOT}/Kept/audio.mp3`,
            Buffer.from("abc"),
            file(),
        );
        await expect(p.removeEmptyDirectory(`${ROOT}/Empty`)).resolves.toBe(
            true,
        );
        await expect(p.removeEmptyDirectory(`${ROOT}/Kept`)).resolves.toBe(
            false,
        );
        await expect(p.removeEmptyDirectory(ROOT)).resolves.toBe(false);
        await expect(p.removeEmptyDirectory(`${ROOT}/Unknown`)).resolves.toBe(
            false,
        );
        expect(drive.tree(ROOT)).toEqual(["Kept/", "Kept/audio.mp3"]);
        expect(nodes.nodes.has(`${ROOT}/Empty`)).toBe(false);
    });

    it("sends a person's file in a managed folder to the trash, not away", async () => {
        const p = provider();
        await p.reconcileDirectory(null, `${ROOT}/Recording`);
        const mine = drive.userAddFile(
            drive.idAt(ROOT, "Recording") ?? "",
            "notes.txt",
        );
        await expect(p.removeEmptyDirectory(`${ROOT}/Recording`)).resolves.toBe(
            true,
        );
        expect(drive.items.has(mine)).toBe(true);
        expect(drive.isTrashed(mine)).toBe(true);
    });

    it("leaves a folder it did not tag alone", async () => {
        const p = provider();
        await p.reconcileDirectory(null, `${ROOT}/Team`);
        const id = drive.idAt(ROOT, "Team") ?? "";
        const item = drive.items.get(id);
        if (item) item.appProperties = {};
        await expect(
            provider().removeEmptyDirectory(`${ROOT}/Team`),
        ).resolves.toBe(false);
        expect(drive.isTrashed(id)).toBe(false);
    });

    it("stops when the picked folder is gone or read-only", async () => {
        drive.items.delete(ROOT);
        await expect(
            provider().reconcileDirectory(null, ROOT),
        ).rejects.toBeInstanceOf(DriveTargetLostError);
        drive.addRoot(ROOT, "Exports", false);
        await expect(
            provider().materialize(`${ROOT}/a.md`, Buffer.from("x"), file()),
        ).rejects.toThrow(/can no longer add files/);
    });

    it("rejects paths outside the picked folder", async () => {
        await expect(
            provider().materialize("otherroot/a.md", Buffer.from("x"), file()),
        ).rejects.toThrow(/outside the export's Drive folder/);
        await expect(
            provider().materialize(`${ROOT}/../a.md`, Buffer.from("x"), file()),
        ).rejects.toThrow();
    });

    it("reports a file missing, resized or of another version", async () => {
        const target = `${ROOT}/Team/audio.mp3`;
        const p = provider();
        const expected = { size: 3, version: "v1", format: "file" as const };
        expect(await p.exists(target, expected)).toBe(false);
        await p.materialize(target, Buffer.from("abc"), file());
        expect(await p.exists(target, expected)).toBe(true);
        expect(await p.exists(target, { ...expected, size: 4 })).toBe(false);
        expect(await p.exists(target, { ...expected, version: "v2" })).toBe(
            false,
        );
    });

    it("plans from one listing instead of a lookup per folder", async () => {
        const seeded = provider();
        for (const name of ["A", "B", "C"]) {
            await seeded.reconcileDirectory(null, `${ROOT}/${name}`);
        }
        drive.calls.length = 0;
        const planning = provider();
        await planning.reconcileDirectory(null, ROOT);
        for (const name of ["A", "B", "C"]) {
            await planning.reconcileDirectory(
                `${ROOT}/${name}`,
                `${ROOT}/${name}`,
            );
        }
        expect(drive.calls).toEqual(["getItem", "listByAppProperty"]);
    });
});

describe("Google Drive export naming", () => {
    it("expands a Markdown artifact into the chosen formats", () => {
        expect(documentFiles("markdown", "riffado.summary.md")).toEqual([
            { format: "file", filename: "riffado.summary.md" },
        ]);
        expect(documentFiles("google_doc", "riffado.summary.md")).toEqual([
            { format: "google_doc", filename: "riffado.summary" },
        ]);
        expect(documentFiles("both", "riffado.summary.md")).toEqual([
            { format: "file", filename: "riffado.summary.md" },
            { format: "google_doc", filename: "riffado.summary" },
        ]);
    });

    it("names content types by extension, Markdown for Docs", () => {
        expect(driveContentType("audio.mp3", "file")).toBe("audio/mpeg");
        expect(driveContentType("audio.ogg", "file")).toBe("audio/ogg");
        expect(driveContentType("x.transcript.md", "file")).toBe(
            "text/markdown",
        );
        expect(driveContentType("x.transcript", "google_doc")).toBe(
            "text/markdown",
        );
        expect(driveContentType("audio.audio", "file")).toBe(
            "application/octet-stream",
        );
    });
});
