"use client";

import { Download, RefreshCw } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useSettings } from "@/hooks/use-settings";
import { EXPORT_FORMATS, type ExportFormat } from "@/lib/export/formats";

// Keyed by `ExportFormat`, so a format added to `EXPORT_FORMATS` without a
// label here is a compile error rather than a blank row in the picker.
const exportFormatLabels: Record<
    ExportFormat,
    { label: string; description: string }
> = {
    json: { label: "JSON", description: "Structured data format" },
    txt: { label: "TXT", description: "Plain text format" },
    srt: { label: "SRT", description: "Subtitle format" },
    vtt: { label: "VTT", description: "WebVTT subtitle format" },
};

interface ExportJobStatus {
    id: string;
    // "expired" is a client-facing derived status: the server reports it
    // instead of "completed" once `expiresAt` has passed, even if the
    // row hasn't been swept from the DB yet (the cleanup worker keeps it
    // until the storage delete actually succeeds).
    status: "pending" | "processing" | "completed" | "failed" | "expired";
    createdAt: string;
    completedAt: string | null;
    expiresAt: string | null;
    recordingCount: number | null;
    fileSize: number | null;
    errorMessage: string | null;
}

const ACTIVE_STATUSES = new Set(["pending", "processing"]);
const POLL_INTERVAL_MS = 4000;

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
}

interface ExportSectionProps {
    onReRunOnboarding?: () => void;
}

export function ExportSection({ onReRunOnboarding }: ExportSectionProps) {
    const i18n = useExtracted();
    const exportFormatOptions = EXPORT_FORMATS.map((value) => ({
        value,
        label: exportFormatLabels[value].label,
        description:
            value === "json"
                ? i18n("Structured data format")
                : value === "txt"
                  ? i18n("Plain text format")
                  : value === "srt"
                    ? i18n("Subtitle format")
                    : i18n("WebVTT subtitle format"),
    }));
    const backupFrequencyOptions = [
        { label: i18n("Never"), value: "never" },
        { label: i18n("Daily"), value: "daily" },
        { label: i18n("Weekly"), value: "weekly" },
        { label: i18n("Monthly"), value: "monthly" },
    ];
    const { isLoadingSettings, isSavingSettings, setIsLoadingSettings } =
        useSettings();
    const [defaultExportFormat, setDefaultExportFormat] = useState("json");
    const [backupFrequency, setBackupFrequency] = useState<string | null>(null);
    const [isExporting, setIsExporting] = useState(false);
    const [isStartingBackup, setIsStartingBackup] = useState(false);
    const [backupJob, setBackupJob] = useState<ExportJobStatus | null>(null);

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const response = await fetch("/api/settings/user");
                if (response.ok) {
                    const data = await response.json();
                    setDefaultExportFormat(data.defaultExportFormat ?? "json");
                    setBackupFrequency(data.backupFrequency ?? null);
                }
            } catch (error) {
                console.error("Failed to fetch settings:", error);
            } finally {
                setIsLoadingSettings(false);
            }
        };
        fetchSettings();
    }, [setIsLoadingSettings]);

    // Pick up the most recent job on load -- covers reopening Settings
    // after starting a backup elsewhere, or arriving from the
    // "export ready" email.
    useEffect(() => {
        const fetchJobs = async () => {
            try {
                const response = await fetch("/api/backup");
                if (!response.ok) return;
                const data = await response.json();
                if (data.jobs?.[0]) setBackupJob(data.jobs[0]);
            } catch {
                // Non-fatal -- the user can still start a fresh backup.
            }
        };
        fetchJobs();
    }, []);

    // Poll while a job is active. Stops itself once the job leaves
    // pending/processing, so there's no polling overhead once idle.
    // Single-flight by construction: the next poll is only scheduled
    // from the previous one's `finally`, so a slow response (>4s)
    // can't cause overlapping in-flight requests and duplicate
    // terminal-state handling (extra toasts).
    useEffect(() => {
        if (!backupJob || !ACTIVE_STATUSES.has(backupJob.status)) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;

        const poll = async () => {
            try {
                const response = await fetch(`/api/backup/${backupJob.id}`);
                if (!cancelled && response.ok) {
                    const data = await response.json();
                    if (!cancelled) {
                        setBackupJob(data.job);
                        if (data.job.status === "completed") {
                            toast.success(i18n("Backup ready to download"));
                        } else if (data.job.status === "failed") {
                            toast.error(i18n("Backup failed to build"));
                        }
                    }
                }
            } catch {
                // Transient -- the next tick will retry.
            } finally {
                if (!cancelled) {
                    timer = setTimeout(poll, POLL_INTERVAL_MS);
                }
            }
        };
        timer = setTimeout(poll, POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [backupJob, i18n]);

    const handleExportBackupSettingChange = async (updates: {
        defaultExportFormat?: string;
        backupFrequency?: string | null;
    }) => {
        const previousValues: Record<string, unknown> = {};
        if (updates.defaultExportFormat !== undefined) {
            previousValues.defaultExportFormat = defaultExportFormat;
            setDefaultExportFormat(updates.defaultExportFormat);
        }
        if (updates.backupFrequency !== undefined) {
            previousValues.backupFrequency = backupFrequency;
            setBackupFrequency(updates.backupFrequency);
        }

        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(updates),
            });

            if (!response.ok) {
                throw new Error("Failed to save settings");
            }
        } catch {
            if (updates.defaultExportFormat !== undefined) {
                const prev = previousValues.defaultExportFormat;
                if (typeof prev === "string") setDefaultExportFormat(prev);
            }
            if (updates.backupFrequency !== undefined) {
                const prev = previousValues.backupFrequency;
                if (typeof prev === "string" || prev === null)
                    setBackupFrequency(prev);
            }
            toast.error(i18n("Failed to save settings. Changes reverted."));
        }
    };

    const handleExport = async () => {
        setIsExporting(true);
        try {
            const response = await fetch(
                `/api/export?format=${defaultExportFormat}`,
            );
            if (!response.ok) throw new Error("Export failed");

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download =
                response.headers
                    .get("Content-Disposition")
                    ?.split("filename=")[1]
                    ?.replace(/"/g, "") || `export.${defaultExportFormat}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);

            toast.success(i18n("Export completed"));
        } catch {
            toast.error(i18n("Failed to export recordings"));
        } finally {
            setIsExporting(false);
        }
    };

    const handleStartBackup = async () => {
        setIsStartingBackup(true);
        try {
            const response = await fetch("/api/backup", { method: "POST" });
            if (!response.ok) throw new Error("Backup request failed");
            const data = await response.json();
            setBackupJob(data.job);
            toast.success(
                ACTIVE_STATUSES.has(data.job.status)
                    ? i18n(
                          "Backup started -- this can take a few minutes for large libraries",
                      )
                    : i18n("Backup ready to download"),
            );
        } catch {
            toast.error(i18n("Failed to start backup"));
        } finally {
            setIsStartingBackup(false);
        }
    };

    if (isLoadingSettings) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="animate-spin size-6 border-2 border-primary border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <SettingsSectionHeader
                title={i18n("Export & Backup")}
                description={i18n(
                    "Take your data with you: recordings, transcripts, and summaries.",
                )}
                icon={Download}
            />
            <div className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="export-format">
                        {i18n("Default export format")}
                    </Label>
                    <Select
                        value={defaultExportFormat}
                        onValueChange={(value) => {
                            setDefaultExportFormat(value);
                            handleExportBackupSettingChange({
                                defaultExportFormat: value,
                            });
                        }}
                        disabled={isSavingSettings}
                    >
                        <SelectTrigger id="export-format" className="w-full">
                            <SelectValue>
                                {exportFormatOptions.find(
                                    (opt) => opt.value === defaultExportFormat,
                                )?.label || i18n("JSON")}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {exportFormatOptions.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    <div>
                                        <div>{option.label}</div>
                                        <div className="text-xs text-muted-foreground">
                                            {option.description}
                                        </div>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="backup-frequency">
                        {i18n("Backup frequency")}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                        {i18n(
                            "Build a full archive — audio, transcripts and summaries — on a schedule, without having to remember. Each one stays downloadable for 7 days and is then deleted.",
                        )}
                    </p>
                    <Select
                        value={backupFrequency || "never"}
                        onValueChange={(value) => {
                            const frequency = value === "never" ? null : value;
                            setBackupFrequency(frequency);
                            handleExportBackupSettingChange({
                                backupFrequency: frequency,
                            });
                        }}
                        disabled={isLoadingSettings || isSavingSettings}
                    >
                        <SelectTrigger id="backup-frequency" className="w-full">
                            <SelectValue>
                                {backupFrequencyOptions.find(
                                    (opt) =>
                                        opt.value ===
                                        (backupFrequency || "never"),
                                )?.label || i18n("Never")}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {backupFrequencyOptions.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "Archives are written wherever the instance's BACKUP_STORAGE_PATH points; without it they land beside your recordings, on the same disk.",
                        )}
                    </p>
                </div>
            </div>

            <div className="pt-4 border-t space-y-3">
                <div className="space-y-2">
                    <Label className="text-base">
                        {i18n("Manual Actions")}
                    </Label>
                    <Button
                        onClick={async () => {
                            try {
                                await fetch("/api/settings/user", {
                                    method: "PUT",
                                    headers: {
                                        "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({
                                        onboardingCompleted: false,
                                    }),
                                });
                                onReRunOnboarding?.();
                            } catch {
                                toast.error(i18n("Failed to reset onboarding"));
                            }
                        }}
                        variant="outline"
                        className="w-full"
                    >
                        <RefreshCw className="size-4 mr-2" />{" "}
                        {i18n("Re-run Onboarding")}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "Reset onboarding to see it again on your next visit",
                        )}
                    </p>
                    <div className="flex gap-2 pt-2">
                        <Button
                            onClick={handleExport}
                            disabled={isExporting}
                            variant="outline"
                            className="flex-1"
                        >
                            {isExporting ? (
                                <>
                                    <div className="animate-spin size-4 mr-2 border-2 border-primary border-t-transparent rounded-full" />{" "}
                                    {i18n("Exporting…")}
                                </>
                            ) : (
                                <>
                                    <Download className="size-4 mr-2" />{" "}
                                    {i18n("Export text")}
                                </>
                            )}
                        </Button>
                        <Button
                            onClick={handleStartBackup}
                            disabled={
                                isStartingBackup ||
                                (backupJob !== null &&
                                    ACTIVE_STATUSES.has(backupJob.status))
                            }
                            variant="outline"
                            className="flex-1"
                        >
                            {isStartingBackup ||
                            (backupJob !== null &&
                                ACTIVE_STATUSES.has(backupJob.status)) ? (
                                <>
                                    <div className="animate-spin size-4 mr-2 border-2 border-primary border-t-transparent rounded-full" />{" "}
                                    {i18n("Building archive…")}
                                </>
                            ) : (
                                <>
                                    <Download className="size-4 mr-2" />{" "}
                                    {i18n("Create full backup")}
                                </>
                            )}
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            '"Export text" downloads transcripts + summaries instantly. "Create full backup" also bundles the original audio into a zip archive; large libraries take a few minutes to build in the background, and you\'ll get an email when it\'s ready.',
                        )}
                    </p>
                    {backupJob && (
                        <div className="rounded-md border p-3 text-sm space-y-1">
                            {backupJob.status === "completed" && (
                                <div className="flex items-center justify-between gap-2">
                                    <span>
                                        {i18n("Backup ready")}{" "}
                                        {backupJob.recordingCount !== null &&
                                            i18n(
                                                " — {count, plural, one {# recording} other {# recordings}}",
                                                {
                                                    count: backupJob.recordingCount,
                                                },
                                            )}
                                        {backupJob.fileSize !== null &&
                                            ` (${formatBytes(backupJob.fileSize)})`}
                                    </span>
                                    <Button asChild size="sm">
                                        <a
                                            href={`/api/backup/${backupJob.id}/download`}
                                        >
                                            <Download className="size-4 mr-2" />{" "}
                                            {i18n("Download")}
                                        </a>
                                    </Button>
                                </div>
                            )}
                            {ACTIVE_STATUSES.has(backupJob.status) && (
                                <span className="text-muted-foreground">
                                    {i18n("Building your archive")}{" "}
                                    {backupJob.status === "pending"
                                        ? i18n(" (queued)")
                                        : ""}
                                    …
                                </span>
                            )}
                            {backupJob.status === "failed" && (
                                <span className="text-destructive">
                                    {i18n(
                                        "Backup failed to build. Try again, or contact support if it keeps failing.",
                                    )}
                                </span>
                            )}
                            {backupJob.status === "expired" && (
                                <span className="text-muted-foreground">
                                    {i18n(
                                        "That backup has expired. Create a new one to download it again.",
                                    )}
                                </span>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
