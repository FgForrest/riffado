"use client";

import { useCallback } from "react";
import { SettingsNavMobile } from "@/components/settings-nav-mobile";
import { SettingsNavSidebar } from "@/components/settings-nav-sidebar";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useSettingsNav } from "@/hooks/use-settings-nav";
import type { SettingsSection } from "@/types/settings";
import { SettingsContent } from "./settings-content";

export interface Provider {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
    createdAt: Date;
}

interface SettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialProviders?: Provider[];
    onReRunOnboarding?: () => void;
    isHosted?: boolean;
    /** Forwarded to `SettingsContent` -> `PlaudAccountSection`. */
    onPlaudReconnected?: () => void;
}

const EMPTY_PROVIDERS: Provider[] = [];

export function SettingsDialog({
    open,
    onOpenChange,
    initialProviders = EMPTY_PROVIDERS,
    onReRunOnboarding,
    isHosted = false,
    onPlaudReconnected,
}: SettingsDialogProps) {
    const onClose = useCallback(() => onOpenChange(false), [onOpenChange]);
    const { activeSection, setActiveSection, keyboardSelectedIndex } =
        useSettingsNav(open, onClose, isHosted);

    const handleSectionChange = useCallback(
        (section: SettingsSection) => setActiveSection(section),
        [setActiveSection],
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {/*
              `--settings-h` is the modal's height, declared once here and
              consumed by both the sidebar and the content pane below. It was
              previously the literal `600px`, repeated in three files that had
              to agree -- which is why the modal stayed exactly 600px tall on a
              1440p monitor and scrolled sections that had screen to spare.
              `min(85dvh,900px)` grows with the viewport and still stops short
              of a full-height wall of settings on a very tall display; `dvh`
              (not `vh`) keeps it correct under a mobile browser's collapsing
              toolbar. Width gains xl/2xl steps for the same reason -- it used
              to cap at 900px no matter how wide the screen got.
            */}
            <DialogContent className="overflow-hidden p-0 [--settings-h:min(85dvh,900px)] md:max-h-[var(--settings-h)] md:max-w-[800px] lg:max-w-[900px] xl:max-w-[1100px] 2xl:max-w-[1280px]">
                <DialogTitle className="sr-only">Settings</DialogTitle>
                <DialogDescription className="sr-only">
                    Customize your settings here. Use arrow keys to navigate
                    sections, Enter or Space to select, and Escape to close.
                </DialogDescription>
                <SidebarProvider className="items-start">
                    <SettingsNavSidebar
                        activeSection={activeSection}
                        keyboardSelectedIndex={keyboardSelectedIndex}
                        onSectionChange={handleSectionChange}
                        isHosted={isHosted}
                    />

                    <main className="flex h-[var(--settings-h,600px)] flex-1 flex-col overflow-hidden">
                        {/*
                          Desktop: header bar is intentionally empty -- the
                          sidebar's active item plus the section h2 inside
                          each pane communicate "where am I"; a third
                          breadcrumb on top was redundant. The h-16 +
                          border-b stays so the rule lines up with the
                          sidebar's "Settings" header.
                          Mobile: the section picker lives here because the
                          sidebar is hidden below md.
                        */}
                        <header className="flex h-16 shrink-0 items-center justify-end gap-2 border-b px-4 md:justify-end">
                            <SettingsNavMobile
                                activeSection={activeSection}
                                onSectionChange={handleSectionChange}
                                isHosted={isHosted}
                            />
                        </header>

                        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 pt-6">
                            <div
                                key={activeSection}
                                className="animate-in fade-in-0 duration-200"
                            >
                                <SettingsContent
                                    activeSection={activeSection}
                                    initialProviders={initialProviders}
                                    onReRunOnboarding={onReRunOnboarding}
                                    isHosted={isHosted}
                                    onPlaudReconnected={onPlaudReconnected}
                                />
                            </div>
                        </div>
                    </main>
                </SidebarProvider>
            </DialogContent>
        </Dialog>
    );
}
