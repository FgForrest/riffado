/** Max stored/display title length. Download basenames use the same cap. */
export const MAX_RECORDING_TITLE_LENGTH = 200;

const DOWNLOAD_PARAM_TRUE = new Set(["1", "true", "yes"]);
const MAX_STORAGE_BASENAME_BYTES = 240;
const MEDIA_FILENAME_EXTENSIONS = new Set([
    "3gp",
    "aac",
    "avi",
    "flac",
    "m4a",
    "m4v",
    "mkv",
    "mov",
    "mp3",
    "mp4",
    "mpeg",
    "mpg",
    "ogg",
    "ogv",
    "opus",
    "wav",
    "webm",
    "wmv",
]);

function stripControlChars(value: string): string {
    let out = "";
    for (const char of value) {
        const code = char.charCodeAt(0);
        if (code < 32 || code === 127) continue;
        out += char;
    }
    return out;
}

/** CON, PRN, AUX, NUL, COM1–9, LPT1–9 — reserved even with an extension. */
const WINDOWS_RESERVED_BASENAME =
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^.]+)?$/i;

function escapeWindowsReservedBasename(name: string): string {
    return WINDOWS_RESERVED_BASENAME.test(name) ? `_${name}` : name;
}

/**
 * Strip C0 controls and trim. Empty string means the caller should reject.
 */
export function normalizeRecordingTitle(value: string): string {
    return stripControlChars(value).trim();
}

export function audioExtension(storagePath: string): string {
    const match = storagePath.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : "mp3";
}

export function recordingAudioDownloadPath(recordingId: string): string {
    return `/api/recordings/${recordingId}/audio?download=1`;
}

export function isAudioDownloadRequest(request: Request): boolean {
    const value = new URL(request.url).searchParams.get("download");
    if (value === null) return false;
    return DOWNLOAD_PARAM_TRUE.has(value.toLowerCase());
}

export function sanitizeDownloadBasename(title: string): string {
    const cleaned = stripControlChars(title)
        .replace(/[/\\:*?"<>|]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) return "";
    const truncated =
        cleaned.length > MAX_RECORDING_TITLE_LENGTH
            ? cleaned.slice(0, MAX_RECORDING_TITLE_LENGTH).trim()
            : cleaned;
    return escapeWindowsReservedBasename(truncated);
}

function utf8Length(value: string): number {
    return new TextEncoder().encode(value).length;
}

function truncateUtf8(value: string, maxBytes: number): string {
    let result = "";
    for (const char of value) {
        if (utf8Length(result + char) > maxBytes) break;
        result += char;
    }
    return result;
}

/** Portable storage filename component derived from a user-facing title. */
export function sanitizeStorageBasename(title: string): string {
    return stripControlChars(title)
        .normalize("NFKD")
        .replace(/\p{Mark}+/gu, "")
        .replace(/[^\p{Letter}\p{Number}._-]+/gu, "_")
        .replace(/_+/g, "_")
        .replace(/^[._-]+|[._-]+$/g, "");
}

/** Stable, filesystem-safe filename shared by audio and document sidecars. */
export function buildRecordingStorageFilename(
    title: string,
    extension: string,
    collisionIndex = 0,
): string {
    const ext = extension.replace(/^\.+/, "").toLowerCase();
    const safeExtension = /^[a-z0-9]+$/.test(ext) ? ext : "mp3";
    const titleExtension = /\.([a-z0-9]+)$/i.exec(title)?.[1].toLowerCase();
    const titleWithoutExtension =
        titleExtension && MEDIA_FILENAME_EXTENSIONS.has(titleExtension)
            ? title.slice(0, -(titleExtension.length + 1))
            : title;
    const safeTitle = sanitizeStorageBasename(titleWithoutExtension);
    const suffix = collisionIndex > 0 ? `-${Math.floor(collisionIndex)}` : "";
    const fixed = `${suffix}.${safeExtension}`;
    const availableTitleBytes = Math.max(
        1,
        MAX_STORAGE_BASENAME_BYTES - utf8Length(fixed),
    );
    const boundedTitle = safeTitle
        ? truncateUtf8(safeTitle, availableTitleBytes).replace(/[._-]+$/g, "")
        : "untitled";
    return escapeWindowsReservedBasename(
        `${boundedTitle || "untitled"}${suffix}.${safeExtension}`,
    );
}

/** User-scoped storage key for a recording's audio file. */
export function buildRecordingStoragePath(
    userId: string,
    title: string,
    extension: string,
    collisionIndex = 0,
): string {
    return `${userId}/${buildRecordingStorageFilename(title, extension, collisionIndex)}`;
}

/** Collision-free staging key used until a readable basename is reserved. */
export function buildRecordingStagingPath(
    userId: string,
    recordingId: string,
    extension: string,
): string {
    const ext = extension.replace(/^\.+/, "").toLowerCase();
    const safeExtension = /^[a-z0-9]+$/.test(ext) ? ext : "mp3";
    const safeId = sanitizeStorageBasename(recordingId) || "recording";
    return `${userId}/.pending/${safeId}.${safeExtension}`;
}

/**
 * Readable download name from the recording title, with the extension taken
 * from `storagePath` (mp3/wav/m4a/…). Empty titles use `untitled`.
 */
export function buildDownloadFilename(
    title: string,
    storagePath: string,
): string {
    return buildRecordingStorageFilename(title, audioExtension(storagePath));
}

/**
 * RFC 6266 / RFC 5987 Content-Disposition for an attachment download.
 * `filename` is the ASCII fallback; `filename*` carries the UTF-8 name.
 */
export function contentDispositionAttachment(filename: string): string {
    const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(filename).replace(
        /['()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
