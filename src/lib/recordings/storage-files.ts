import type { StorageProvider } from "@/lib/storage/types";
import { getAudioMimeType } from "@/lib/utils";

interface StorageCopy {
    source: string;
    destination: string;
    contentType: string;
}

/** Storage key for a document placed beside its recording audio. */
export function sidecarKey(
    audioPath: string,
    kind: "transcript" | "summary",
    source?: string,
): string {
    const slash = audioPath.lastIndexOf("/");
    const dir = slash === -1 ? "" : audioPath.slice(0, slash + 1);
    const base = audioPath.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const sourceSegment = source ? `.${sidecarSourceSegment(source)}` : "";
    return `${dir}${stem}${sourceSegment}.${kind}.md`;
}

function sidecarSourceSegment(source: string): string {
    if (source === "riffado") return "custom";
    return source.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown";
}

/** Copy every present audio/sidecar file to a recording's new storage stem. */
export async function copyExistingRecordingFiles(
    storage: StorageProvider,
    oldAudioPath: string,
    newAudioPath: string,
): Promise<string[]> {
    const sidecarCopies: StorageCopy[] = [
        undefined,
        "plaud",
        "riffado",
        "mixed",
    ].flatMap((source) =>
        (["transcript", "summary"] as const).map((kind) => ({
            source: sidecarKey(oldAudioPath, kind, source),
            destination: sidecarKey(newAudioPath, kind, source),
            contentType: "text/markdown; charset=utf-8",
        })),
    );
    const copies: StorageCopy[] = [
        ...sidecarCopies,
        {
            source: oldAudioPath,
            destination: newAudioPath,
            contentType: getAudioMimeType(newAudioPath),
        },
    ];
    const copiedSources: string[] = [];

    for (const copy of copies) {
        if (!(await storage.exists(copy.source))) continue;
        if (storage.copyFile) {
            await storage.copyFile(copy.source, copy.destination);
        } else {
            const stream = await storage.downloadStream(copy.source);
            await storage.uploadStream(
                copy.destination,
                stream,
                copy.contentType,
            );
        }
        copiedSources.push(copy.source);
    }

    return copiedSources;
}

/** Remove old keys after their replacements and database path are durable. */
export async function deleteOldRecordingFiles(
    storage: StorageProvider,
    sourceKeys: readonly string[],
    recordingId: string,
): Promise<void> {
    const deletions = await Promise.allSettled(
        sourceKeys.map((key) => storage.deleteFile(key)),
    );
    for (const deletion of deletions) {
        if (deletion.status === "rejected") {
            console.error(
                `Failed to remove an old storage file for recording ${recordingId}:`,
                deletion.reason,
            );
        }
    }
}
