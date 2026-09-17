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
        key: "remoteOriginal",
        setting: "retentionRemoteOriginalDays",
        label: "Remote original",
        hint: "Moves the original to the connected recorder service's Trash, but only after it has been downloaded locally.",
    },
    {
        key: "localAudio",
        setting: "retentionLocalAudioDays",
        label: "Local audio",
        hint: "Riffado's stored audio copy. It cannot be re-transcribed once both local and remote copies are gone.",
    },
    {
        key: "localTranscript",
        setting: "retentionLocalTranscriptDays",
        label: "Local transcript",
        hint: "Deleted from Riffado's database. It can be regenerated if audio is still available.",
    },
    {
        key: "localSummary",
        setting: "retentionLocalSummaryDays",
        label: "Local summary",
        hint: "Summary, key points and action items.",
    },
] as const;

type RetentionKey = (typeof RETENTION_KINDS)[number]["key"];
type RetentionSetting = (typeof RETENTION_KINDS)[number]["setting"];
type RetentionPolicyState = Record<
    RetentionKey,
    { enabled: boolean; days: number }
>;

const DEFAULT_RETENTION_POLICY: RetentionPolicyState = {
    remoteOriginal: { enabled: false, days: 30 },
    localAudio: { enabled: false, days: 30 },
    localTranscript: { enabled: false, days: 30 },
    localSummary: { enabled: false, days: 30 },
};

function readRetentionPolicy(
    settings: Record<string, unknown>,
): RetentionPolicyState {
    const policy = structuredClone(DEFAULT_RETENTION_POLICY);
    for (const item of RETENTION_KINDS) {
        const value = settings[item.setting];
        if (
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= 1 &&
            value <= 365
        ) {
            policy[item.key] = { enabled: true, days: value };
        }
    }
    return policy;
}

function retentionPayload(
    policy: RetentionPolicyState,
): Record<RetentionSetting, number | null> {
    return Object.fromEntries(
        RETENTION_KINDS.map((item) => [
            item.setting,
            policy[item.key].enabled ? policy[item.key].days : null,
        ]),
    ) as Record<RetentionSetting, number | null>;
}

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
    const [retentionPolicy, setRetentionPolicy] = useState(
        DEFAULT_RETENTION_POLICY,
    );
    const retentionPolicyRef = useRef(DEFAULT_RETENTION_POLICY);
    const persistedRetentionPolicyRef = useRef(DEFAULT_RETENTION_POLICY);
    const retentionSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
    // How many recordings the current selection would reap right now.
    // `null` = not asked yet or nothing selected.
    const [reapPreview, setReapPreview] = useState<{ count: number } | null>(
        null,
    );
    const [usage, setUsage] = useState<StorageUsage | null>(null);
    // Distinct from `usage === null` so we can tell "haven't loaded
    // yet" apart from "loaded and the API returned no shape we can
    // use". Without this, the UsageHero rendered all-zero numbers
    // during the fetch — indistinguishable from a real empty account.
    const [isLoadingUsage, setIsLoadingUsage] = useState(true);
    const saveTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
    // Tracks a retention edit scheduled but not yet sent, so closing the
    // settings dialog inside the debounce window does not drop it.
    const pendingRetentionRef = useRef<RetentionPolicyState | undefined>(
        undefined,
    );

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
                    const data = (await response.json()) as Record<
                        string,
                        unknown
                    >;
                    if (cancelled) return;
                    const policy = readRetentionPolicy(data);
                    retentionPolicyRef.current = policy;
                    persistedRetentionPolicyRef.current = policy;
                    setRetentionPolicy(policy);
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
                void retentionSaveQueueRef.current.finally(() =>
                    fetch("/api/settings/user", {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(retentionPayload(pending)),
                    }).catch(() => {}),
                );
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
        const payload = retentionPayload(retentionPolicy);
        const anySelected = Object.values(payload).some(
            (days) => days !== null,
        );
        if (!anySelected) {
            setReapPreview(null);
            return;
        }

        const controller = new AbortController();
        const params = new URLSearchParams();
        for (const item of RETENTION_KINDS) {
            const days = payload[item.setting];
            if (days !== null) params.set(`${item.key}Days`, String(days));
        }

        // Debounced on the same 500ms as the save below. The days field
        // updates state on every keystroke, so typing "365" would
        // otherwise issue three counts against the recordings table for
        // two intermediate values nobody asked about.
        const timer = setTimeout(() => {
            fetch(`/api/settings/retention/preview?${params}`, {
                signal: controller.signal,
            })
                .then((res) => (res.ok ? res.json() : null))
                .then((data) => {
                    if (typeof data?.count !== "number") return;
                    setReapPreview({ count: data.count });
                })
                .catch(() => {
                    // A missing hint is not worth a toast; the setting
                    // still saves and the sweep still reports what it did.
                });
        }, 500);

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [retentionPolicy]);

    const cancelPendingRetentionSave = () => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = undefined;
        }
        pendingRetentionRef.current = undefined;
    };

    const persistRetentionPolicy = (
        next: RetentionPolicyState,
        previous?: RetentionPolicyState,
    ): Promise<void> => {
        const save = async () => {
            try {
                const response = await fetch("/api/settings/user", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(retentionPayload(next)),
                });
                if (!response.ok) throw new Error("Failed to save settings");
                persistedRetentionPolicyRef.current = next;
            } catch {
                if (previous && retentionPolicyRef.current === next) {
                    const persisted = persistedRetentionPolicyRef.current;
                    retentionPolicyRef.current = persisted;
                    setRetentionPolicy(persisted);
                    toast.error("Failed to save settings. Changes reverted.");
                }
            }
        };
        const queued = retentionSaveQueueRef.current.then(save, save);
        retentionSaveQueueRef.current = queued;
        return queued;
    };

    const flushPendingRetentionSave = () => {
        const pending = pendingRetentionRef.current;
        cancelPendingRetentionSave();
        if (pending === undefined) return;
        void persistRetentionPolicy(pending);
    };

    const setRetentionEnabled = (key: RetentionKey, enabled: boolean) => {
        cancelPendingRetentionSave();
        const previous = retentionPolicyRef.current;
        const next = {
            ...previous,
            [key]: { ...previous[key], enabled },
        };
        retentionPolicyRef.current = next;
        setRetentionPolicy(next);
        void persistRetentionPolicy(next, previous);
    };

    const setRetentionDays = (key: RetentionKey, days: number) => {
        const previous = retentionPolicyRef.current;
        const next = {
            ...previous,
            [key]: { ...previous[key], days },
        };
        retentionPolicyRef.current = next;
        setRetentionPolicy(next);
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        pendingRetentionRef.current = next;
        saveTimeoutRef.current = setTimeout(() => {
            saveTimeoutRef.current = undefined;
            pendingRetentionRef.current = undefined;
            void persistRetentionPolicy(next, previous);
        }, 500);
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
                description="Set a separate retention period for each copy. Off means it is kept indefinitely. The recording entry stays in your library."
            >
                <div className="divide-y rounded-lg border">
                    {RETENTION_KINDS.map(({ key, label, hint }) => {
                        const value = retentionPolicy[key];
                        return (
                            <div key={key} className="space-y-3 p-4">
                                <div className="flex items-start justify-between gap-4">
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
                                        checked={value.enabled}
                                        onCheckedChange={(checked) =>
                                            setRetentionEnabled(key, checked)
                                        }
                                        disabled={isSavingSettings}
                                    />
                                </div>
                                <div className="flex items-center gap-2">
                                    <Label
                                        htmlFor={`retention-${key}-days`}
                                        className="text-xs text-muted-foreground"
                                    >
                                        Retention period
                                    </Label>
                                    <Input
                                        id={`retention-${key}-days`}
                                        className="h-8 w-24"
                                        type="number"
                                        inputMode="numeric"
                                        min={1}
                                        max={365}
                                        step={1}
                                        value={value.days}
                                        disabled={
                                            !value.enabled || isSavingSettings
                                        }
                                        onChange={(event) => {
                                            const days = Number(
                                                event.target.value,
                                            );
                                            if (
                                                Number.isInteger(days) &&
                                                days >= 1 &&
                                                days <= 365
                                            ) {
                                                setRetentionDays(key, days);
                                            }
                                        }}
                                        onBlur={(event) => {
                                            event.currentTarget.value = String(
                                                retentionPolicy[key].days,
                                            );
                                            flushPendingRetentionSave();
                                        }}
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        days (1-365)
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <p className="text-xs text-muted-foreground">
                    {reapPreview === null
                        ? "When all options are off, data is kept indefinitely."
                        : reapPreview.count === 0
                          ? "No recordings are old enough yet, so this deletes nothing today."
                          : `Applies to ${reapPreview.count} recording${reapPreview.count === 1 ? "" : "s"} right now. The first sweep runs within the hour.`}
                </p>
                <p className="text-xs text-muted-foreground">
                    Remote originals are moved to Trash only after a successful
                    local download. Markdown files written by Export/Backup are
                    left alone.
                </p>
            </SettingsCard>
        </div>
    );
}
