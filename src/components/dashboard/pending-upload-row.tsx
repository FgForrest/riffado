"use client";

import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export type PendingUploadPhase =
    | "uploading"
    | "queued"
    | "preparing"
    | "extracting"
    | "saving";

export interface PendingUpload {
    id: string;
    filename: string;
    filesize: number;
    phase: PendingUploadPhase;
    progress: number | null;
}

function formatSize(bytes: number) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PendingUploadRow({
    upload,
    rowPadding,
}: {
    upload: PendingUpload;
    rowPadding: string;
}) {
    const percent = upload.progress ?? 0;
    let status: string;
    switch (upload.phase) {
        case "uploading":
            status = `Uploading… ${percent}% of ${formatSize(upload.filesize)}`;
            break;
        case "queued":
            status = "Upload complete. Waiting to extract audio…";
            break;
        case "preparing":
            status = "Preparing video…";
            break;
        case "extracting":
            status = `Extracting audio… ${percent}%`;
            break;
        case "saving":
            status = "Saving audio…";
            break;
    }

    return (
        <div className={cn("flex items-center gap-3", rowPadding)}>
            <Loader2 className="size-4 animate-spin text-primary" />
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-muted-foreground">
                    {upload.filename}
                </p>
                <p className="text-xs text-muted-foreground">{status}</p>
                {(upload.phase === "uploading" ||
                    upload.phase === "extracting") && (
                    <Progress
                        value={percent}
                        className="mt-1.5 h-1"
                        aria-label={status}
                    />
                )}
            </div>
        </div>
    );
}
