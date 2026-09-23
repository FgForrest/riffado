"use client";

import { AudioWaveform, Loader2 } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import type { ReactNode } from "react";
import { RecordingTitle } from "@/components/recordings/recording-title";
import { formatBytes } from "@/lib/format-bytes";
import { formatDateTime } from "@/lib/format-date";
import { formatDuration } from "@/lib/format-duration";
import type { Recording } from "@/types/recording";

interface RecordingPlayerHeaderProps {
    recording: Recording;
    action?: ReactNode;
    onRenamed?: (filename: string) => void;
}

interface RecordingWaveformStatusProps {
    scrubberStyle: "waveform" | "slider";
    waveformStatus: "idle" | "ready" | "decoding" | "skipped" | "error";
    onDecodeWaveform: () => void;
}

/**
 * Recording identity and destructive actions sit outside the player card so
 * every artifact panel reads as a peer below the same page-level heading.
 */
export function RecordingPlayerHeader({
    recording,
    action,
    onRenamed,
}: RecordingPlayerHeaderProps) {
    const locale = useLocale();
    const i18n = useExtracted();
    const metaParts: string[] = [
        formatDateTime(recording.startTime, "relative", locale),
        formatDuration(recording.duration / 1000),
        formatBytes(recording.filesize),
    ];
    if (recording.view === "org") {
        metaParts.push(
            recording.isOwn
                ? i18n("Organization view")
                : i18n("Shared by {owner}", {
                      owner: recording.ownerName ?? i18n("a colleague"),
                  }),
        );
    }

    return (
        <header className="flex min-w-0 items-start justify-between gap-4 px-1">
            <div className="min-w-0 flex-1">
                <h1 className="min-w-0">
                    <RecordingTitle
                        recordingId={recording.id}
                        filename={recording.filename}
                        onRenamed={onRenamed}
                        readOnly={recording.isOwn === false}
                        className="text-xl font-semibold tracking-tight sm:text-2xl"
                    />
                </h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    {metaParts.map((part, i) => (
                        <span
                            key={part}
                            className="inline-flex items-center gap-2"
                        >
                            {i > 0 && (
                                <span aria-hidden="true" className="opacity-40">
                                    ·
                                </span>
                            )}
                            <span>{part}</span>
                        </span>
                    ))}
                </div>
            </div>
            {action && <div className="shrink-0">{action}</div>}
        </header>
    );
}

export function RecordingWaveformStatus({
    scrubberStyle,
    waveformStatus,
    onDecodeWaveform,
}: RecordingWaveformStatusProps) {
    const i18n = useExtracted();
    if (scrubberStyle !== "waveform" || waveformStatus === "ready") {
        return null;
    }

    return (
        <div className="flex min-h-5 items-center text-xs text-muted-foreground">
            {waveformStatus === "decoding" && (
                <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="size-3 animate-spin" />{" "}
                    {i18n("Analyzing audio…")}
                </span>
            )}
            {waveformStatus === "skipped" && (
                <button
                    type="button"
                    onClick={onDecodeWaveform}
                    className="inline-flex items-center gap-1.5 underline-offset-2 hover:text-foreground hover:underline"
                    title={i18n(
                        "Decode waveform in your browser (may take a few seconds)",
                    )}
                >
                    <AudioWaveform className="size-3" />{" "}
                    {i18n("Generate waveform")}
                </button>
            )}
            {waveformStatus === "error" && (
                <button
                    type="button"
                    onClick={onDecodeWaveform}
                    className="inline-flex items-center gap-1.5 text-destructive underline-offset-2 hover:underline"
                >
                    <AudioWaveform className="size-3" />{" "}
                    {i18n("Retry waveform")}
                </button>
            )}
            {waveformStatus === "idle" && (
                <span className="sr-only">
                    {i18n("Waveform is not available")}
                </span>
            )}
        </div>
    );
}
