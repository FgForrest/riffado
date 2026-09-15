"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
    { href: "/dashboard", label: "Recordings" },
    { href: "/people", label: "People" },
] as const;

/**
 * The app's top-level sections.
 *
 * Riffado had exactly one view until the knowledge base arrived, so this is
 * the first navigation it has ever had. Deliberately two plain links rather
 * than a shell rewrite: the header already carries the page identity, and a
 * sidebar for two destinations would be furniture.
 */
export function AppNav({ className }: { className?: string }) {
    const pathname = usePathname();

    return (
        <nav
            aria-label="Sections"
            className={`flex items-baseline gap-4 ${className ?? ""}`}
        >
            {SECTIONS.map((section) => {
                const active = pathname.startsWith(section.href);
                return (
                    <Link
                        key={section.href}
                        href={section.href}
                        aria-current={active ? "page" : undefined}
                        className={
                            active
                                ? "text-xl font-semibold leading-tight sm:text-2xl md:text-3xl"
                                : "text-xl font-semibold leading-tight text-muted-foreground transition-colors hover:text-foreground sm:text-2xl md:text-3xl"
                        }
                    >
                        {section.label}
                    </Link>
                );
            })}
        </nav>
    );
}
