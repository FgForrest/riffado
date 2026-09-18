"use client";

import { RefreshCw } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { ToggleRow } from "@/components/settings/toggle-row";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useSettings } from "@/hooks/use-settings";

const syncIntervalPresets = [
    60 * 1000,
    2 * 60 * 1000,
    5 * 60 * 1000,
    10 * 60 * 1000,
    15 * 60 * 1000,
    30 * 60 * 1000,
    60 * 60 * 1000,
];

export function SyncSection() {
    const i18n = useExtracted();
    const { isLoadingSettings, isSavingSettings, setIsLoadingSettings } =
        useSettings();
    const [syncInterval, setSyncInterval] = useState(300000);
    const [autoSyncEnabled, setAutoSyncEnabled] = useState(true);
    const [syncOnMount, setSyncOnMount] = useState(true);
    const [syncOnVisibilityChange, setSyncOnVisibilityChange] = useState(true);
    const [syncNotifications, setSyncNotifications] = useState(true);
    const getSyncIntervalLabel = (value: number) => {
        if (value === 60 * 60 * 1000) return i18n("1 hour");
        const minutes = value / (60 * 1000);
        return Number.isInteger(minutes)
            ? i18n(
                  "{count, plural, one {# minute} few {# minutes} other {# minutes}}",
                  { count: minutes },
              )
            : i18n("Custom");
    };

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const response = await fetch("/api/settings/user");
                if (response.ok) {
                    const data = await response.json();
                    setSyncInterval(data.syncInterval ?? 300000);
                    setAutoSyncEnabled(data.autoSyncEnabled ?? true);
                    setSyncOnMount(data.syncOnMount ?? true);
                    setSyncOnVisibilityChange(
                        data.syncOnVisibilityChange ?? true,
                    );
                    setSyncNotifications(data.syncNotifications ?? true);
                }
            } catch (error) {
                console.error("Failed to fetch settings:", error);
            } finally {
                setIsLoadingSettings(false);
            }
        };
        fetchSettings();
    }, [setIsLoadingSettings]);

    const handleSyncSettingChange = async (updates: {
        syncInterval?: number;
        autoSyncEnabled?: boolean;
        syncOnMount?: boolean;
        syncOnVisibilityChange?: boolean;
        syncNotifications?: boolean;
    }) => {
        const previousValues: Record<string, unknown> = {};
        if (updates.syncInterval !== undefined) {
            previousValues.syncInterval = syncInterval;
            setSyncInterval(updates.syncInterval);
        }
        if (updates.autoSyncEnabled !== undefined) {
            previousValues.autoSyncEnabled = autoSyncEnabled;
            setAutoSyncEnabled(updates.autoSyncEnabled);
        }
        if (updates.syncOnMount !== undefined) {
            previousValues.syncOnMount = syncOnMount;
            setSyncOnMount(updates.syncOnMount);
        }
        if (updates.syncOnVisibilityChange !== undefined) {
            previousValues.syncOnVisibilityChange = syncOnVisibilityChange;
            setSyncOnVisibilityChange(updates.syncOnVisibilityChange);
        }
        if (updates.syncNotifications !== undefined) {
            previousValues.syncNotifications = syncNotifications;
            setSyncNotifications(updates.syncNotifications);
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
            if (updates.syncInterval !== undefined) {
                const prev = previousValues.syncInterval;
                if (typeof prev === "number") setSyncInterval(prev);
            }
            if (updates.autoSyncEnabled !== undefined) {
                const prev = previousValues.autoSyncEnabled;
                if (typeof prev === "boolean") setAutoSyncEnabled(prev);
            }
            if (updates.syncOnMount !== undefined) {
                const prev = previousValues.syncOnMount;
                if (typeof prev === "boolean") setSyncOnMount(prev);
            }
            if (updates.syncOnVisibilityChange !== undefined) {
                const prev = previousValues.syncOnVisibilityChange;
                if (typeof prev === "boolean") setSyncOnVisibilityChange(prev);
            }
            if (updates.syncNotifications !== undefined) {
                const prev = previousValues.syncNotifications;
                if (typeof prev === "boolean") setSyncNotifications(prev);
            }
            toast.error(i18n("Failed to save settings. Changes reverted."));
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
                title={i18n("Sync")}
                description={i18n(
                    "When and how Riffado pulls new recordings from your Plaud device.",
                )}
                icon={RefreshCw}
            />
            <div className="space-y-3">
                <SettingsCard title={i18n("Auto-sync")}>
                    <ToggleRow
                        id="auto-sync"
                        label={i18n("Enable auto-sync")}
                        description={i18n(
                            "Automatically sync recordings from your Plaud device at regular intervals.",
                        )}
                        checked={autoSyncEnabled}
                        onCheckedChange={(checked) => {
                            setAutoSyncEnabled(checked);
                            handleSyncSettingChange({
                                autoSyncEnabled: checked,
                            });
                        }}
                        disabled={isSavingSettings}
                    />

                    {autoSyncEnabled && (
                        <div className="mt-3 space-y-3 border-t pt-3">
                            <div className="space-y-2">
                                <Label htmlFor="sync-interval">
                                    {i18n("Sync interval")}
                                </Label>
                                <Select
                                    value={syncInterval.toString()}
                                    onValueChange={(value) => {
                                        const interval = parseInt(value, 10);
                                        setSyncInterval(interval);
                                        handleSyncSettingChange({
                                            syncInterval: interval,
                                        });
                                    }}
                                    disabled={isSavingSettings}
                                >
                                    <SelectTrigger
                                        id="sync-interval"
                                        className="w-full"
                                    >
                                        <SelectValue>
                                            {getSyncIntervalLabel(syncInterval)}
                                        </SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                        {syncIntervalPresets.map((preset) => (
                                            <SelectItem
                                                key={preset}
                                                value={preset.toString()}
                                            >
                                                {getSyncIntervalLabel(preset)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <ToggleRow
                                id="sync-on-mount"
                                label={i18n("Sync on app load")}
                                description={i18n(
                                    "Automatically sync when the app first loads.",
                                )}
                                checked={syncOnMount}
                                onCheckedChange={(checked) => {
                                    setSyncOnMount(checked);
                                    handleSyncSettingChange({
                                        syncOnMount: checked,
                                    });
                                }}
                                disabled={isSavingSettings}
                            />

                            <ToggleRow
                                id="sync-on-visibility"
                                label={i18n("Sync on tab visibility")}
                                description={i18n(
                                    "Sync when you return to the app tab.",
                                )}
                                checked={syncOnVisibilityChange}
                                onCheckedChange={(checked) => {
                                    setSyncOnVisibilityChange(checked);
                                    handleSyncSettingChange({
                                        syncOnVisibilityChange: checked,
                                    });
                                }}
                                disabled={isSavingSettings}
                            />
                        </div>
                    )}
                </SettingsCard>

                <SettingsCard title={i18n("Notifications")}>
                    <ToggleRow
                        id="sync-notifications"
                        label={i18n("Show sync notifications")}
                        description={i18n(
                            "Display notifications when sync completes.",
                        )}
                        checked={syncNotifications}
                        onCheckedChange={(checked) => {
                            setSyncNotifications(checked);
                            handleSyncSettingChange({
                                syncNotifications: checked,
                            });
                        }}
                        disabled={isSavingSettings}
                    />
                </SettingsCard>
            </div>
        </div>
    );
}
