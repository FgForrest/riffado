"use client";

import { Settings as SettingsIcon } from "lucide-react";
import { useExtracted } from "next-intl";
import { useMemo } from "react";
import {
    buildSettingsNav,
    buildSettingsNavGroups,
} from "@/components/settings-nav-config";
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { SettingsSection } from "@/types/settings";

interface Props {
    activeSection: SettingsSection;
    keyboardSelectedIndex: number;
    onSectionChange: (section: SettingsSection) => void;
    isHosted: boolean;
}

/**
 * Desktop sidebar navigation. Hidden below md (the mobile picker
 * lives in the dialog header). Grouped layout for visual scanning,
 * but the underlying nav is a single flat list -- the parent's
 * keyboard handler indexes the flat order via `settingsNav`.
 */
export function SettingsNavSidebar({
    activeSection,
    keyboardSelectedIndex,
    onSectionChange,
    isHosted,
}: Props) {
    const i18n = useExtracted();
    const settingsNavGroups = useMemo(
        () => buildSettingsNavGroups({ isHosted }),
        [isHosted],
    );
    const settingsNav = useMemo(
        () => buildSettingsNav({ isHosted }),
        [isHosted],
    );
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
    const groupLabel = (label: string) => {
        switch (label) {
            case "AI":
                return i18n("AI");
            case "Plaud":
                return i18n("Plaud");
            case "Personalize":
                return i18n("Personalize");
            case "Data":
                return i18n("Data");
            case "Integrations":
                return i18n("Integrations");
            case "Advanced":
                return i18n("Advanced");
            case "Account":
                return i18n("Account");
            default:
                return label;
        }
    };
    return (
        // Sidebar needs an explicit height to match <main>'s, otherwise
        // SidebarContent's overflow-y-auto has no bound to scroll against:
        // DialogContent uses max-h (a constraint, not a definite height) so
        // the sidebar's h-full would resolve to its content height and grow
        // rather than scroll once we cross ~13 nav items.
        //
        // `--settings-h` is set on DialogContent in `settings-dialog.tsx`, the
        // only place this component is used. The `600px` fallback is the old
        // fixed height, so a future consumer that forgets the variable gets
        // today's layout rather than a collapsed sidebar.
        <Sidebar className="hidden md:flex md:h-[var(--settings-h,600px)]">
            {/*
              Header sits outside SidebarContent so it doesn't scroll
              away with the nav. Match the main panel <header>'s h-16
              exactly so the two bottom borders line up.
            */}
            <div className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
                <SettingsIcon className="size-5" />
                <h2 className="text-lg font-semibold">{i18n("Settings")}</h2>
            </div>
            <SidebarContent className="min-h-0">
                {/*
                  Use a real <nav> for the navigation landmark instead
                  of overloading SidebarMenu (which renders <ul>) with
                  role="navigation". Each group below has its own <ul>
                  via SidebarMenu, so <li> items always sit under a
                  proper list parent -- fixing the previous ul > div >
                  li nesting which is invalid HTML and confuses screen
                  readers.
                */}
                <nav
                    aria-label={i18n("Settings sections")}
                    className="space-y-4"
                >
                    {settingsNavGroups.map((group) => (
                        <SidebarGroup key={group.label} className="space-y-1">
                            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                                {groupLabel(group.label)}
                            </div>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    {group.items.map((item) => {
                                        // Resolve the item's flat
                                        // index so keyboard nav (which
                                        // still indexes a flat list)
                                        // stays in sync with what's
                                        // rendered.
                                        const flatIndex = settingsNav.findIndex(
                                            (n) => n.id === item.id,
                                        );
                                        return (
                                            <SidebarMenuItem key={item.id}>
                                                <SidebarMenuButton
                                                    data-settings-nav={
                                                        flatIndex === 0
                                                            ? "first"
                                                            : undefined
                                                    }
                                                    isActive={
                                                        activeSection ===
                                                        item.id
                                                    }
                                                    data-keyboard-selected={
                                                        keyboardSelectedIndex ===
                                                        flatIndex
                                                    }
                                                    onClick={() =>
                                                        onSectionChange(item.id)
                                                    }
                                                    aria-label={i18n(
                                                        "{section} settings",
                                                        {
                                                            section:
                                                                sectionName(
                                                                    item.id,
                                                                ),
                                                        },
                                                    )}
                                                    aria-current={
                                                        activeSection ===
                                                        item.id
                                                            ? "page"
                                                            : undefined
                                                    }
                                                    className={
                                                        item.id === "dev"
                                                            ? "text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 data-[active=true]:bg-red-500/10 data-[active=true]:text-red-700 dark:data-[active=true]:text-red-300"
                                                            : undefined
                                                    }
                                                >
                                                    <item.icon
                                                        className="size-4"
                                                        aria-hidden="true"
                                                    />
                                                    <span>
                                                        {sectionName(item.id)}
                                                    </span>
                                                </SidebarMenuButton>
                                            </SidebarMenuItem>
                                        );
                                    })}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    ))}
                </nav>
            </SidebarContent>
        </Sidebar>
    );
}
