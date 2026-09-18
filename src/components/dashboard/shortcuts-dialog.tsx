"use client";

import { useExtracted } from "next-intl";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

interface ShortcutsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

interface ShortcutRow {
    keys: string[];
    description: string;
}

function Kbd({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-foreground shadow-sm">
            {children}
        </kbd>
    );
}

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
    const i18n = useExtracted();
    const groups: { title: string; rows: ShortcutRow[] }[] = [
        {
            title: i18n("Global"),
            rows: [
                { keys: ["⌘", "K"], description: i18n("Command palette") },
                { keys: ["?"], description: i18n("Show this cheatsheet") },
                { keys: [","], description: i18n("Open settings") },
                { keys: ["/"], description: i18n("Focus search") },
            ],
        },
        {
            title: i18n("Recording list"),
            rows: [
                { keys: ["j"], description: i18n("Next recording") },
                { keys: ["k"], description: i18n("Previous recording") },
            ],
        },
        {
            title: i18n("Player"),
            rows: [
                { keys: ["Space"], description: i18n("Play / pause") },
                { keys: ["←"], description: i18n("Seek back 5s") },
                { keys: ["→"], description: i18n("Seek forward 5s") },
                { keys: ["↑"], description: i18n("Volume up") },
                { keys: ["↓"], description: i18n("Volume down") },
            ],
        },
    ];
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{i18n("Keyboard shortcuts")}</DialogTitle>
                    <DialogDescription>
                        {i18n(
                            "Power-user shortcuts available across the dashboard.",
                        )}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-5">
                    {groups.map((group) => (
                        <div key={group.title}>
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                {group.title}
                            </h3>
                            <ul className="space-y-1.5">
                                {group.rows.map((row) => (
                                    <li
                                        key={row.description}
                                        className="flex items-center justify-between text-sm"
                                    >
                                        <span className="text-foreground">
                                            {row.description}
                                        </span>
                                        <span className="flex items-center gap-1">
                                            {row.keys.map((k) => (
                                                <Kbd key={k}>{k}</Kbd>
                                            ))}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}
