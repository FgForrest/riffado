import { createReadStream } from "node:fs";
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    FilesystemExportProvider,
    validateRelativeExportPath,
} from "@/lib/folder-exports/filesystem-provider";
import {
    allocateDirectoryName,
    folderDirectory,
    recordingDirectory,
    safePathSegment,
} from "@/lib/folder-exports/naming";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(
        roots.splice(0).map((root) => rm(root, { recursive: true })),
    );
});

describe("filesystem export provider", () => {
    it("rejects traversal, absolute paths, backslashes, and malformed segments", () => {
        for (const value of ["../escape", "/absolute", "a\\b", "a//b", "./a"]) {
            expect(() => validateRelativeExportPath(value)).toThrow();
        }
        expect(validateRelativeExportPath("team/weekly/file.md")).toBe(
            "team/weekly/file.md",
        );
    });

    it("writes atomically and is safe to repeat", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "riffado-export-"));
        roots.push(root);
        const provider = new FilesystemExportProvider(root);
        await provider.materialize(
            "team/item/transcript.md",
            Buffer.from("one"),
        );
        await provider.materialize(
            "team/item/transcript.md",
            Buffer.from("two"),
        );
        expect(
            await readFile(path.join(root, "team/item/transcript.md"), "utf8"),
        ).toBe("two");
        expect(await provider.exists("team/item/transcript.md", 3)).toBe(true);
    });

    it("finishes a streamed write, as audio exports are", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "riffado-export-"));
        roots.push(root);
        const source = path.join(root, "source.mp3");
        await writeFile(source, "audio-bytes");
        const provider = new FilesystemExportProvider(root);
        await provider.materialize(
            "team/item/audio.mp3",
            createReadStream(source),
        );
        expect(
            await readFile(path.join(root, "team/item/audio.mp3"), "utf8"),
        ).toBe("audio-bytes");
    });

    it("rejects symlink traversal beneath the configured root", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "riffado-export-"));
        const outside = await mkdtemp(
            path.join(os.tmpdir(), "riffado-outside-"),
        );
        roots.push(root, outside);
        await symlink(outside, path.join(root, "linked"), "dir");
        const provider = new FilesystemExportProvider(root);
        await expect(
            provider.materialize("linked/file.md", Buffer.from("content")),
        ).rejects.toThrow(/symlink/);
    });

    it("uses readable names and disambiguates only actual collisions", () => {
        expect(safePathSegment("../Team/Notes", "recording")).toBe(
            "..-Team-Notes",
        );
        expect(recordingDirectory("Same title")).toBe("Same title");
        expect(folderDirectory("Team/Notes")).toBe("Team-Notes");
        expect(
            allocateDirectoryName("Same title", new Set(["Same title"])),
        ).toBe("Same title (2)");
        expect(
            allocateDirectoryName(
                "Same title",
                new Set(["Same title", "Same title (2)"]),
            ),
        ).toBe("Same title (3)");
    });

    it("renames a stale directory and preserves its contents", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "riffado-export-"));
        roots.push(root);
        await mkdir(path.join(root, "team/Old recording"), { recursive: true });
        await writeFile(
            path.join(root, "team/Old recording/transcript.md"),
            "content",
        );
        const provider = new FilesystemExportProvider(root);
        await expect(
            provider.reconcileDirectory(
                "team/Old recording",
                "team/New recording",
            ),
        ).resolves.toEqual({ contentPreserved: true });
        await expect(
            readFile(
                path.join(root, "team/New recording/transcript.md"),
                "utf8",
            ),
        ).resolves.toBe("content");
    });

    it("creates the new directory when the stale directory is missing", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "riffado-export-"));
        roots.push(root);
        const provider = new FilesystemExportProvider(root);
        await expect(
            provider.reconcileDirectory(
                "team/Missing recording",
                "team/New recording",
            ),
        ).resolves.toEqual({ contentPreserved: false });
        await provider.materialize(
            "team/New recording/transcript.md",
            Buffer.from("restored"),
        );
        await expect(
            readFile(
                path.join(root, "team/New recording/transcript.md"),
                "utf8",
            ),
        ).resolves.toBe("restored");
    });

    it("checks a file without creating the directories on its path", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "riffado-export-"));
        roots.push(root);
        await mkdir(path.join(root, "team/Old recording"), { recursive: true });
        const provider = new FilesystemExportProvider(root);
        await provider.reconcileDirectory(
            "team/Old recording",
            "team/New recording",
        );
        // A path read before the rename used to recreate the old directory.
        await expect(
            provider.exists("team/Old recording/transcript.md", 7),
        ).resolves.toBe(false);
        await expect(
            provider.exists("gone/Old recording/transcript.md", 7),
        ).resolves.toBe(false);
        await expect(readdir(path.join(root, "team"))).resolves.toEqual([
            "New recording",
        ]);
        await expect(readdir(root)).resolves.toEqual(["team"]);
    });

    it("removes a directory only while it is empty", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "riffado-export-"));
        roots.push(root);
        await mkdir(path.join(root, "team/Empty"), { recursive: true });
        await mkdir(path.join(root, "team/Kept"));
        await writeFile(path.join(root, "team/Kept/notes.md"), "mine");
        const provider = new FilesystemExportProvider(root);
        await expect(provider.removeEmptyDirectory("team/Empty")).resolves.toBe(
            true,
        );
        await expect(provider.removeEmptyDirectory("team/Kept")).resolves.toBe(
            false,
        );
        await expect(
            provider.removeEmptyDirectory("team/Missing"),
        ).resolves.toBe(false);
        await expect(
            provider.removeEmptyDirectory("gone/Missing"),
        ).resolves.toBe(false);
        await expect(
            provider.removeEmptyDirectory("team/Kept/notes.md"),
        ).resolves.toBe(false);
        await expect(readdir(path.join(root, "team"))).resolves.toEqual([
            "Kept",
        ]);
    });

    it("never removes through a symlink", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "riffado-export-"));
        const outside = await mkdtemp(
            path.join(os.tmpdir(), "riffado-outside-"),
        );
        roots.push(root, outside);
        await mkdir(path.join(outside, "empty"));
        await mkdir(path.join(root, "team"));
        await symlink(outside, path.join(root, "team/Link"), "dir");
        const provider = new FilesystemExportProvider(root);
        await expect(provider.removeEmptyDirectory("team/Link")).resolves.toBe(
            false,
        );
        await expect(
            provider.removeEmptyDirectory("team/Link/empty"),
        ).rejects.toThrow(/symlink/);
        await expect(readdir(outside)).resolves.toEqual(["empty"]);
    });

    it("rejects symlink directories during rename reconciliation", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "riffado-export-"));
        const outside = await mkdtemp(
            path.join(os.tmpdir(), "riffado-outside-"),
        );
        roots.push(root, outside);
        await mkdir(path.join(root, "team"));
        await symlink(outside, path.join(root, "team/Stale"), "dir");
        const provider = new FilesystemExportProvider(root);
        await expect(
            provider.reconcileDirectory("team/Stale", "team/Current"),
        ).rejects.toThrow(/regular directory/);
    });
});
