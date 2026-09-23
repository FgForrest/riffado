"use client";

import { useExtracted } from "next-intl";
import { useMemo } from "react";
import { buildSettingsNav } from "@/components/settings-nav-config";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { SettingsSection } from "@/types/settings";

interface Props {
    activeSection: SettingsSection;
    onSectionChange: (section: SettingsSection) => void;
    isHosted: boolean;
}

/**
 * Section picker shown in the dialog header below md. Replaces the
 * sidebar (hidden at that breakpoint) so users on small screens
 * still have a way to switch sections without a separate route.
 */
export function SettingsNavMobile({
    activeSection,
    onSectionChange,
    isHosted,
}: Props) {
    const i18n = useExtracted();
    const settingsNav = useMemo(
        () => buildSettingsNav({ isHosted }),
        [isHosted],
    );
    const activeNavItem = settingsNav.find((item) => item.id === activeSection);
    const sectionName = (section: SettingsSection) => {
        switch (section) {
            case "providers":
                return i18n("Providers");
            case "transcription":
                return i18n("Transcription");
            case "summary":
                return i18n("Summary");
            case "plaud-account":
                return i18n("Plaud Account");
            case "sync":
                return i18n("Sync");
            case "playback":
                return i18n("Playback");
            case "display":
                return i18n("Display");
            case "notifications":
                return i18n("Notifications");
            case "storage":
                return i18n("Storage");
            case "export":
                return i18n("Export/Backup");
            case "api-keys":
                return i18n("API Keys");
            case "webhooks":
                return i18n("Webhooks");
            case "billing":
                return i18n("Billing");
            case "google-account":
                return i18n("Google Account");
            case "dev":
                return i18n("Developer Tools");
        }
    };

    return (
        <div className="md:hidden">
            <Select
                value={activeSection}
                onValueChange={(value) =>
                    onSectionChange(value as SettingsSection)
                }
            >
                <SelectTrigger
                    className="w-[180px]"
                    aria-label={i18n("Select settings section")}
                >
                    <SelectValue>
                        {activeNavItem
                            ? sectionName(activeNavItem.id)
                            : i18n("Settings")}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {settingsNav.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                            <div className="flex items-center gap-2">
                                <item.icon className="size-4" />
                                <span>{sectionName(item.id)}</span>
                            </div>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
