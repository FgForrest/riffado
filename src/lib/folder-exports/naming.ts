import path from "node:path";

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

export function recordingDirectory(title: string, recordingId: string): string {
    return `${safePathSegment(title, "recording")}--${safePathSegment(recordingId, "id")}`;
}

export function folderDirectory(name: string, folderId: string): string {
    return `${safePathSegment(name, "folder")}--${safePathSegment(folderId, "id")}`;
}

export function sourceFilename(
    source: string,
    artifact: "transcript" | "summary",
): string {
    return `${safePathSegment(source, "unknown")}.${artifact}.md`;
}
