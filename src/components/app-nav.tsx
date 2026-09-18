"use client";

import { Mic, UsersRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useExtracted } from "next-intl";
import { WaveformLogo } from "@/components/icons/waveform-logo";
import { cn } from "@/lib/utils";

/**
 * The app's top-level sections.
 *
 * Riffado had exactly one view until the knowledge base arrived, so this is
 * the first navigation it has ever had. Deliberately two plain links rather
 * than a shell rewrite: the header already carries the page identity, and a
 * sidebar for two destinations would be furniture.
 */
export function AppNav({ className }: { className?: string }) {
    const i18n = useExtracted();
    const pathname = usePathname();
    const sections = [
        { href: "/dashboard", label: i18n("Recordings"), icon: Mic },
        { href: "/people", label: i18n("People"), icon: UsersRound },
    ] as const;

    return (
        <div className={cn("flex min-w-0 items-center gap-6", className)}>
            <Link
                href="/dashboard"
                aria-label={i18n("Riffado home")}
                className="hidden shrink-0 text-primary transition-opacity hover:opacity-80 md:block"
            >
                <WaveformLogo className="h-10 w-9" />
            </Link>
            <nav
                aria-label={i18n("Sections")}
                className="flex h-11 min-w-0 items-stretch overflow-hidden rounded-xl border border-border/90 bg-card/30 shadow-sm sm:h-[54px]"
            >
                {sections.map((section) => {
                    const active = pathname.startsWith(section.href);
                    const Icon = section.icon;
                    return (
                        <Link
                            key={section.href}
                            href={section.href}
                            aria-current={active ? "page" : undefined}
                            aria-label={section.label}
                            className={cn(
                                "relative flex min-w-12 items-center justify-center gap-2.5 px-3 text-sm font-semibold tracking-tight transition-[color,background-color] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:gap-3 sm:px-9 sm:text-lg",
                                active
                                    ? "bg-primary/[0.12] text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                            )}
                        >
                            <Icon
                                className={cn(
                                    "size-[18px] shrink-0 sm:size-5",
                                    active && "text-primary",
                                )}
                                strokeWidth={1.9}
                            />
                            <span className="hidden sm:inline">
                                {section.label}
                            </span>
                        </Link>
                    );
                })}
            </nav>
        </div>
    );
}
