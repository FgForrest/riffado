import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    FilesystemExportProvider,
    validateRelativeExportPath,
} from "@/lib/folder-exports/filesystem-provider";
import {
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

    it("uses safe collision-resistant recording directories", () => {
        expect(safePathSegment("../Team/Notes", "recording")).toBe(
            "..-Team-Notes",
        );
        expect(recordingDirectory("Same title", "rec-1")).not.toBe(
            recordingDirectory("Same title", "rec-2"),
        );
        expect(folderDirectory("A/B", "folder-1")).not.toBe(
            folderDirectory("A\\B", "folder-2"),
        );
    });
});
