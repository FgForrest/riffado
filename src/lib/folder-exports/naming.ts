import path from "node:path";
import type { DocumentFormat, ExportFormat } from "./types";

export function safePathSegment(value: string, fallback: string): string {
    const normalized = Array.from(value.normalize("NFKC"))
        .map((character) => {
            const code = character.charCodeAt(0);
            return code <= 31 ||
                code === 127 ||
                '/\\:*?"<>|'.includes(character)
                ? "-"
                : character;
        })
        .join("")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .trim();
    const safe = normalized === "." || normalized === ".." ? "" : normalized;
    return (safe || fallback).slice(0, 120);
}

export function audioExtension(storageFilename: string | null): string {
    const extension = path.extname(storageFilename ?? "").toLowerCase();
    return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".audio";
}

export function recordingDirectory(title: string): string {
    return safePathSegment(title, "recording");
}

export function folderDirectory(name: string): string {
    return safePathSegment(name, "folder");
}

export function allocateDirectoryName(
    preferred: string,
    occupied: ReadonlySet<string>,
): string {
    if (!occupied.has(preferred)) return preferred;
    for (let ordinal = 2; ; ordinal += 1) {
        const suffix = ` (${ordinal})`;
        const candidate = `${preferred.slice(0, 120 - suffix.length)}${suffix}`;
        if (!occupied.has(candidate)) return candidate;
    }
}

export function sourceFilename(
    source: string,
    artifact: "transcript" | "summary",
): string {
    return `${safePathSegment(source, "unknown")}.${artifact}.md`;
}

/**
 * The files one Markdown artifact becomes: the `.md` file, a Google Doc
 * named without the extension, or both.
 */
export function documentFiles(
    format: DocumentFormat,
    markdownFilename: string,
): Array<{ format: ExportFormat; filename: string }> {
    const markdown = { format: "file" as const, filename: markdownFilename };
    const doc = {
        format: "google_doc" as const,
        filename: markdownFilename.replace(/\.md$/, ""),
    };
    switch (format) {
        case "markdown":
            return [markdown];
        case "google_doc":
            return [doc];
        case "both":
            return [markdown, doc];
    }
}
