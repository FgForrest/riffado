import * as path from "node:path";

export const AUDIO_UPLOAD_EXTENSIONS = new Set([
    ".mp3",
    ".mp4",
    ".m4a",
    ".wav",
    ".ogg",
    ".opus",
    ".webm",
    ".aac",
    ".flac",
]);

export const VIDEO_UPLOAD_EXTENSIONS = new Set([
    ".mp4",
    ".mov",
    ".m4v",
    ".webm",
    ".mkv",
    ".avi",
    ".mpeg",
    ".mpg",
    ".wmv",
    ".3gp",
    ".ogv",
]);

const AMBIGUOUS_CONTAINER_EXTENSIONS = new Set([".mp4", ".webm"]);

export function uploadExtension(filename: string): string {
    return path.extname(filename).toLowerCase();
}

export function isSupportedUpload(filename: string, mimeType: string): boolean {
    const extension = uploadExtension(filename);
    return (
        mimeType.toLowerCase().startsWith("video/") ||
        AUDIO_UPLOAD_EXTENSIONS.has(extension) ||
        VIDEO_UPLOAD_EXTENSIONS.has(extension)
    );
}

export function shouldExtractVideo(
    filename: string,
    mimeType: string,
): boolean {
    const extension = uploadExtension(filename);
    if (mimeType.toLowerCase().startsWith("video/")) return true;
    if (!VIDEO_UPLOAD_EXTENSIONS.has(extension)) return false;
    if (!AMBIGUOUS_CONTAINER_EXTENSIONS.has(extension)) return true;
    return !mimeType.toLowerCase().startsWith("audio/");
}

export function acceptedUploadExtensions(): string {
    return [
        ...new Set([...AUDIO_UPLOAD_EXTENSIONS, ...VIDEO_UPLOAD_EXTENSIONS]),
    ]
        .sort()
        .join(", ");
}
