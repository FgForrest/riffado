"use client";

import { HardDrive } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { BreakdownBar } from "@/components/settings-sections/storage/breakdown-bar";
import { LargestRecordings } from "@/components/settings-sections/storage/largest-recordings";
import { UsageHero } from "@/components/settings-sections/storage/usage-hero";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/use-settings";

interface StorageSectionProps {
    isHosted?: boolean;
}

const RETENTION_KINDS = [
    {
        key: "audio",
        label: "Audio",
        hint: "The recording itself. Almost all of the disk space, and it cannot be re-transcribed once gone.",
    },
    {
        key: "transcript",
        label: "Transcript",
        hint: "Deleted from the database. Can be regenerated later only if the audio is kept.",
    },
    {
        key: "summary",
        label: "Summary",
        hint: "Summary, key points and action items.",
    },
] as const;

interface StorageUsage {
    storageType: string;
    usedBytes: number;
    recordingCount: number;
    totalDurationMs: number;
    largest: {
        id: string;
        filename: string;
        filesize: number;
        duration: number;
        startTime: string;
    }[];
    diskFreeBytes: number | null;
    quotaBytes: number | null;
}

export function StorageSection({ isHosted = false }: StorageSectionProps) {
    const { isLoadingSettings, isSavingSettings, setIsLoadingSettings } =
        useSettings();
    const [autoDeleteRecordings, setAutoDeleteRecordings] = useState(false);
    const [retentionDays, setRetentionDays] = useState<number | null>(null);
    const [deleteAudio, setDeleteAudio] = useState(false);
    const [deleteTranscript, setDeleteTranscript] = useState(false);
    const [deleteSummary, setDeleteSummary] = useState(false);
    // How many recordings the current selection would reap right now.
    // `null` = not asked yet or nothing selected.
    const [reapPreview, setReapPreview] = useState<{
        count: number;
        capped: boolean;
    } | null>(null);
    const [usage, setUsage] = useState<StorageUsage | null>(null);
    // Distinct from `usage === null` so we can tell "haven't loaded
    // yet" apart from "loaded and the API returned no shape we can
    // use". Without this, the UsageHero rendered all-zero numbers
    // during the fetch — indistinguishable from a real empty account.
    const [isLoadingUsage, setIsLoadingUsage] = useState(true);
    const saveTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
    // Tracks a retention-days edit that was scheduled but not yet sent.
    // Used to flush the pending save on unmount so closing the settings
    // dialog inside the debounce window doesn't drop the user's edit.
    const pendingRetentionRef = useRef<number | null | undefined>(undefined);

    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        const fetchSettings = async () => {
            try {
                const response = await fetch("/api/settings/user", {
                    signal: controller.signal,
                });
                if (cancelled) return;
                if (response.ok) {
                    const data = await response.json();
                    if (cancelled) return;
                    setAutoDeleteRecordings(data.autoDeleteRecordings ?? false);
                    setRetentionDays(data.retentionDays ?? null);
                    setDeleteAudio(data.retentionDeleteAudio ?? false);
                    setDeleteTranscript(
                        data.retentionDeleteTranscript ?? false,
                    );
                    setDeleteSummary(data.retentionDeleteSummary ?? false);
                }
            } catch (error) {
                if (cancelled) return;
                if ((error as { name?: string })?.name === "AbortError") return;
                console.error("Failed to fetch settings:", error);
            } finally {
                if (!cancelled) setIsLoadingSettings(false);
            }
        };
        fetchSettings();

        setIsLoadingUsage(true);
        fetch("/api/settings/storage", { signal: controller.signal })
            .then(async (res) => {
                if (!res.ok) return null;
                const data = (await res.json()) as Partial<StorageUsage>;
                // Defensive shape check — only the fields the UI actually
                // reads. Missing optional fields fall back to safe zeros.
                if (
                    typeof data?.usedBytes === "number" &&
                    typeof data?.recordingCount === "number" &&
                    Array.isArray(data?.largest)
                ) {
                    return {
                        storageType: data.storageType ?? "local",
                        usedBytes: data.usedBytes,
                        recordingCount: data.recordingCount,
                        totalDurationMs: data.totalDurationMs ?? 0,
                        largest: data.largest,
                        diskFreeBytes: data.diskFreeBytes ?? null,
                        quotaBytes: data.quotaBytes ?? null,
                    } satisfies StorageUsage;
                }
                return null;
            })
            .then((data) => {
                if (cancelled) return;
                setUsage(data);
                setIsLoadingUsage(false);
            })
            .catch((err) => {
                if (cancelled) return;
                if ((err as { name?: string })?.name === "AbortError") return;
                setUsage(null);
                setIsLoadingUsage(false);
            });

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [setIsLoadingSettings]);

    useEffect(() => {
        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
                saveTimeoutRef.current = undefined;
            }
            const pending = pendingRetentionRef.current;
            if (pending !== undefined) {
                pendingRetentionRef.current = undefined;
                // Fire-and-forget so a pending edit isn't lost when the
                // settings dialog closes inside the debounce window. We can't
                // use handleStorageSettingChange here because it touches
                // unmounted React state on rollback; we accept the trade-off
                // of no error toast in this rare edge case.
                void fetch("/api/settings/user", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ retentionDays: pending }),
                }).catch(() => {});
            }
        };
    }, []);

    // Ask the server how much the current selection would delete. This is
    // the whole safety story of the feature: retention is the one setting
    // here that destroys data, and a number in front of the user before
    // the first sweep beats finding out afterwards. Driven by the live
    // form values rather than the saved ones, so the answer is about the
    // choice being made, not the one already in effect.
    useEffect(() => {
        const anySelected = deleteAudio || deleteTranscript || deleteSummary;
        if (!autoDeleteRecordings || !retentionDays || !anySelected) {
            setReapPreview(null);
            return;
        }

        const controller = new AbortController();
        const params = new URLSearchParams({
            days: String(retentionDays),
            audio: String(deleteAudio),
            transcript: String(deleteTranscript),
            summary: String(deleteSummary),
        });

        fetch(`/api/settings/retention/preview?${params}`, {
            signal: controller.signal,
        })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (typeof data?.count !== "number") return;
                setReapPreview({
                    count: data.count,
                    capped: data.capped === true,
                });
            })
            .catch(() => {
                // A missing hint is not worth a toast; the setting still
                // saves and the sweep still reports what it did.
            });

        return () => controller.abort();
    }, [
        autoDeleteRecordings,
        retentionDays,
        deleteAudio,
        deleteTranscript,
        deleteSummary,
    ]);

    const cancelPendingRetentionSave = () => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = undefined;
        }
        pendingRetentionRef.current = undefined;
    };

    const flushPendingRetentionSave = () => {
        const pending = pendingRetentionRef.current;
        cancelPendingRetentionSave();
        if (pending === undefined) return;
        handleStorageSettingChange({ retentionDays: pending });
    };

    const handleStorageSettingChange = async (updates: {
        autoDeleteRecordings?: boolean;
        retentionDays?: number | null;
        retentionDeleteAudio?: boolean;
        retentionDeleteTranscript?: boolean;
        retentionDeleteSummary?: boolean;
    }) => {
        const previousValues: Record<string, unknown> = {};
        if (updates.autoDeleteRecordings !== undefined) {
            previousValues.autoDeleteRecordings = autoDeleteRecordings;
            setAutoDeleteRecordings(updates.autoDeleteRecordings);
        }
        if (updates.retentionDays !== undefined) {
            previousValues.retentionDays = retentionDays;
            setRetentionDays(updates.retentionDays);
        }
        if (updates.retentionDeleteAudio !== undefined) {
            previousValues.retentionDeleteAudio = deleteAudio;
            setDeleteAudio(updates.retentionDeleteAudio);
        }
        if (updates.retentionDeleteTranscript !== undefined) {
            previousValues.retentionDeleteTranscript = deleteTranscript;
            setDeleteTranscript(updates.retentionDeleteTranscript);
        }
        if (updates.retentionDeleteSummary !== undefined) {
            previousValues.retentionDeleteSummary = deleteSummary;
            setDeleteSummary(updates.retentionDeleteSummary);
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
            if (updates.autoDeleteRecordings !== undefined) {
                const prev = previousValues.autoDeleteRecordings;
                if (typeof prev === "boolean") setAutoDeleteRecordings(prev);
            }
            if (updates.retentionDays !== undefined) {
                const prev = previousValues.retentionDays;
                if (typeof prev === "number" || prev === null)
                    setRetentionDays(prev);
            }
            if (updates.retentionDeleteAudio !== undefined) {
                const prev = previousValues.retentionDeleteAudio;
                if (typeof prev === "boolean") setDeleteAudio(prev);
            }
            if (updates.retentionDeleteTranscript !== undefined) {
                const prev = previousValues.retentionDeleteTranscript;
                if (typeof prev === "boolean") setDeleteTranscript(prev);
            }
            if (updates.retentionDeleteSummary !== undefined) {
                const prev = previousValues.retentionDeleteSummary;
                if (typeof prev === "boolean") setDeleteSummary(prev);
            }
            toast.error("Failed to save settings. Changes reverted.");
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
                title="Storage"
                description="Where Riffado keeps the audio files behind your recordings."
                icon={HardDrive}
            />

            {isLoadingUsage ? (
                // Match UsageHero's vertical footprint so the layout
                // doesn't jump when the fetch resolves. animate-pulse
                // signals "data on the way" without committing to
                // specific numbers (which would falsely read as
                // "you have 0 recordings").
                <div
                    className="h-32 animate-pulse rounded-lg border bg-muted/40"
                    aria-hidden="true"
                />
            ) : usage ? (
                <UsageHero
                    usedBytes={usage.usedBytes}
                    recordingCount={usage.recordingCount}
                    totalDurationMs={usage.totalDurationMs}
                    diskFreeBytes={usage.diskFreeBytes}
                    quotaBytes={usage.quotaBytes}
                />
            ) : (
                <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                    Couldn't load storage usage. Refresh to try again.
                </div>
            )}

            {!isLoadingUsage && usage && usage.largest.length > 0 && (
                <div className="space-y-3">
                    <BreakdownBar
                        segments={usage.largest.map((r) => ({
                            id: r.id,
                            bytes: r.filesize,
                        }))}
                        totalBytes={usage.usedBytes}
                    />
                    <LargestRecordings items={usage.largest} />
                </div>
            )}

            {!isHosted && (
                <div className="rounded-lg border bg-card/40 px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Backend</span>
                        <span className="font-medium capitalize">
                            {usage?.storageType ?? "local"}
                        </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Storage backend is configured at the instance level via
                        environment variables.
                    </p>
                </div>
            )}

            <SettingsCard
                title="Auto-delete old data"
                description="Once a recording passes the retention period, remove the kinds of data you select below. The recording itself stays in your library."
                action={
                    <Switch
                        id="auto-delete"
                        checked={autoDeleteRecordings}
                        onCheckedChange={(checked) => {
                            // The toggle settles retentionDays itself, so any
                            // debounced retention edit is now stale and must
                            // not be flushed on unmount.
                            cancelPendingRetentionSave();
                            setAutoDeleteRecordings(checked);
                            if (!checked) {
                                setRetentionDays(null);
                            }
                            // Nothing is selected by default, so switching
                            // this on would otherwise arm a policy that
                            // deletes nothing. Pre-tick audio -- the one
                            // people mean when they say "delete old
                            // recordings", and the only one whose absence
                            // frees real space -- while leaving the text
                            // alone until it is asked for explicitly.
                            const armAudio =
                                checked &&
                                !deleteAudio &&
                                !deleteTranscript &&
                                !deleteSummary;
                            handleStorageSettingChange({
                                autoDeleteRecordings: checked,
                                retentionDays: checked ? retentionDays : null,
                                ...(armAudio
                                    ? { retentionDeleteAudio: true }
                                    : {}),
                            });
                        }}
                        disabled={isSavingSettings}
                    />
                }
            >
                {autoDeleteRecordings && (
                    <div className="space-y-2">
                        <Label htmlFor="retention-days">
                            Retention period (days)
                        </Label>
                        <Input
                            id="retention-days"
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={365}
                            step={1}
                            value={retentionDays || ""}
                            onChange={(e) => {
                                const raw = e.target.value;
                                if (raw === "") {
                                    setRetentionDays(null);
                                    if (saveTimeoutRef.current) {
                                        clearTimeout(saveTimeoutRef.current);
                                        saveTimeoutRef.current = undefined;
                                    }
                                    pendingRetentionRef.current = undefined;
                                    handleStorageSettingChange({
                                        retentionDays: null,
                                    });
                                    return;
                                }
                                const value = Number(raw);
                                if (
                                    !Number.isInteger(value) ||
                                    value < 1 ||
                                    value > 365
                                ) {
                                    // Reject non-integer or out-of-range
                                    // values silently. Previously parseInt
                                    // would silently floor "1.5" to 1 and
                                    // save it; we now require an integer.
                                    return;
                                }
                                setRetentionDays(value);
                                if (saveTimeoutRef.current) {
                                    clearTimeout(saveTimeoutRef.current);
                                }
                                pendingRetentionRef.current = value;
                                saveTimeoutRef.current = setTimeout(() => {
                                    saveTimeoutRef.current = undefined;
                                    pendingRetentionRef.current = undefined;
                                    handleStorageSettingChange({
                                        retentionDays: value,
                                    });
                                }, 500);
                            }}
                            onBlur={flushPendingRetentionSave}
                            placeholder="30"
                        />
                        <p className="text-xs text-muted-foreground">
                            Counted from when the recording was made (1-365
                            days)
                        </p>

                        <div className="space-y-3 rounded-lg border p-4">
                            <div className="space-y-0.5">
                                <Label className="text-sm">
                                    What to delete
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                    Each kind is independent. Dropping the audio
                                    and keeping the text reclaims almost all the
                                    space; keeping only the summary is equally
                                    valid.
                                </p>
                            </div>

                            {RETENTION_KINDS.map(({ key, label, hint }) => (
                                <div
                                    key={key}
                                    className="flex items-center justify-between gap-4"
                                >
                                    <div className="space-y-0.5">
                                        <Label
                                            htmlFor={`retention-${key}`}
                                            className="text-sm font-normal"
                                        >
                                            {label}
                                        </Label>
                                        <p className="text-xs text-muted-foreground">
                                            {hint}
                                        </p>
                                    </div>
                                    <Switch
                                        id={`retention-${key}`}
                                        checked={
                                            key === "audio"
                                                ? deleteAudio
                                                : key === "transcript"
                                                  ? deleteTranscript
                                                  : deleteSummary
                                        }
                                        onCheckedChange={(checked) =>
                                            handleStorageSettingChange(
                                                key === "audio"
                                                    ? {
                                                          retentionDeleteAudio:
                                                              checked,
                                                      }
                                                    : key === "transcript"
                                                      ? {
                                                            retentionDeleteTranscript:
                                                                checked,
                                                        }
                                                      : {
                                                            retentionDeleteSummary:
                                                                checked,
                                                        },
                                            )
                                        }
                                        disabled={isSavingSettings}
                                    />
                                </div>
                            ))}

                            <p className="text-xs text-muted-foreground">
                                {reapPreview === null
                                    ? "Pick at least one kind and a retention period — nothing is deleted until you do."
                                    : reapPreview.count === 0
                                      ? "No recordings are old enough yet, so this deletes nothing today."
                                      : `Applies to ${reapPreview.capped ? "over 1000" : reapPreview.count} recording${reapPreview.count === 1 && !reapPreview.capped ? "" : "s"} right now. The first sweep runs within the hour and cannot be undone.`}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                Markdown files written alongside your audio by
                                Export/Backup are left alone — retention removes
                                Riffado's copy, not the export in your folder.
                            </p>
                        </div>
                    </div>
                )}
            </SettingsCard>
        </div>
    );
}
