import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExportProvider } from "./types";

export const MAX_EXPORT_PATH_LENGTH = 1024;

export function validateRelativeExportPath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_EXPORT_PATH_LENGTH) {
        throw new Error("Export path must be between 1 and 1024 characters");
    }
    if (trimmed.includes("\0") || trimmed.includes("\\")) {
        throw new Error("Export path contains invalid characters");
    }
    if (path.posix.isAbsolute(trimmed)) {
        throw new Error("Export path must be relative to the configured root");
    }
    const parts = trimmed.split("/");
    if (
        parts.some(
            (part) =>
                part.length === 0 ||
                part === "." ||
                part === ".." ||
                part.length > 255,
        )
    ) {
        throw new Error("Export path contains an invalid segment");
    }
    return parts.join("/");
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
}

async function ensureSafeParent(
    configuredRoot: string,
    relativePath: string,
): Promise<{ root: string; target: string }> {
    if (!path.isAbsolute(configuredRoot)) {
        throw new Error("FILESYSTEM_EXPORT_ROOT must be an absolute path");
    }
    await mkdir(configuredRoot, { recursive: true });
    const root = await realpath(configuredRoot);
    const normalized = validateRelativeExportPath(relativePath);
    const parts = normalized.split("/");
    const filename = parts.pop();
    if (!filename) throw new Error("Export path needs a filename");

    let parent = root;
    for (const part of parts) {
        const candidate = path.join(parent, part);
        try {
            const stat = await lstat(candidate);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new Error(
                    "Export path crosses a non-directory or symlink",
                );
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await mkdir(candidate);
        }
        parent = await realpath(candidate);
        if (!isWithin(root, parent)) {
            throw new Error("Export path escapes the configured root");
        }
    }

    return { root, target: path.join(parent, filename) };
}

async function resolveSafeParent(
    configuredRoot: string,
    relativePath: string,
): Promise<{ root: string; target: string } | null> {
    if (!path.isAbsolute(configuredRoot)) {
        throw new Error("FILESYSTEM_EXPORT_ROOT must be an absolute path");
    }
    await mkdir(configuredRoot, { recursive: true });
    const root = await realpath(configuredRoot);
    const normalized = validateRelativeExportPath(relativePath);
    const parts = normalized.split("/");
    const name = parts.pop();
    if (!name) throw new Error("Export path needs a directory name");

    let parent = root;
    for (const part of parts) {
        const candidate = path.join(parent, part);
        try {
            const stat = await lstat(candidate);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new Error(
                    "Export path crosses a non-directory or symlink",
                );
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
        }
        parent = await realpath(candidate);
        if (!isWithin(root, parent)) {
            throw new Error("Export path escapes the configured root");
        }
    }
    return { root, target: path.join(parent, name) };
}

async function directoryExists(target: string): Promise<boolean> {
    try {
        const stat = await lstat(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error("Export directory is not a regular directory");
        }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export class FilesystemExportProvider implements ExportProvider {
    private readonly root: string;

    constructor(root: string) {
        if (!root) throw new Error("Filesystem export is not configured");
        this.root = root;
    }

    async exists(relativePath: string, expectedSize: number): Promise<boolean> {
        const { root, target } = await ensureSafeParent(
            this.root,
            relativePath,
        );
        if (!isWithin(root, target)) return false;
        try {
            const stat = await lstat(target);
            return (
                !stat.isSymbolicLink() &&
                stat.isFile() &&
                stat.size === expectedSize
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return false;
            throw error;
        }
    }

    async reconcileDirectory(
        previousPath: string | null,
        currentPath: string,
    ): Promise<{ contentPreserved: boolean }> {
        const current = await ensureSafeParent(this.root, currentPath);
        const currentExists = await directoryExists(current.target);

        if (previousPath && previousPath !== currentPath) {
            const previous = await resolveSafeParent(this.root, previousPath);
            if (previous && (await directoryExists(previous.target))) {
                if (currentExists) {
                    throw new Error(
                        "Cannot rename an export directory over an existing directory",
                    );
                }
                await rename(previous.target, current.target);
                return { contentPreserved: true };
            }
            if (!currentExists) await mkdir(current.target);
            return { contentPreserved: false };
        }

        if (currentExists) return { contentPreserved: true };
        await mkdir(current.target);
        return { contentPreserved: false };
    }

    async materialize(
        relativePath: string,
        content: Buffer | Readable,
    ): Promise<void> {
        const { root, target } = await ensureSafeParent(
            this.root,
            relativePath,
        );
        if (!isWithin(root, target)) {
            throw new Error("Export path escapes the configured root");
        }
        try {
            const current = await lstat(target);
            if (current.isSymbolicLink() || !current.isFile()) {
                throw new Error("Export target is not a regular file");
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        const temporary = `${target}.riffado-${crypto.randomUUID()}.tmp`;
        const handle = await open(
            temporary,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_WRONLY |
                constants.O_NOFOLLOW,
            0o600,
        );
        try {
            if (Buffer.isBuffer(content)) {
                await handle.writeFile(content);
            } else {
                await pipeline(
                    content,
                    handle.createWriteStream({ autoClose: false }),
                );
            }
            await handle.sync();
            await handle.close();
            const parent = await realpath(path.dirname(target));
            if (!isWithin(root, parent)) {
                throw new Error("Export path changed during materialization");
            }
            await rename(temporary, target);
        } catch (error) {
            await handle.close().catch(() => {});
            await unlink(temporary).catch(() => {});
            throw error;
        }
    }
}
