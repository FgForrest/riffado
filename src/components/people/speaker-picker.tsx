"use client";

import { Check, UserPlus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface PickablePerson {
    id: string;
    displayName: string;
    primaryEmail: string | null;
}

export interface SpeakerPickerProps {
    /** The raw provider label being named, e.g. `speaker_0`. */
    label: string;
    /** Currently attributed person, if any. */
    personId: string | null;
    /**
     * Exactly one of the two is ever set: `personId` to attribute an
     * existing person, `displayName` to create and attribute a new one.
     */
    onPick: (choice: { personId?: string; displayName?: string }) => void;
    onClear: () => void;
    onClose: () => void;
}

/**
 * Name one speaker.
 *
 * Offers the people already known before the option to create somebody, since
 * after a few recordings the answer is almost always a repeat participant.
 * Typing a name that matches nobody creates them, so naming a new person is
 * one action rather than a detour through the People section.
 */
export function SpeakerPicker({
    label,
    personId,
    onPick,
    onClear,
    onClose,
}: SpeakerPickerProps) {
    const [people, setPeople] = useState<PickablePerson[] | null>(null);
    const [query, setQuery] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        void fetch("/api/people")
            .then((response) =>
                response.ok ? response.json() : { people: [] },
            )
            .then((body: { people?: PickablePerson[] }) => {
                if (!cancelled) setPeople(body.people ?? []);
            })
            .catch(() => {
                if (!cancelled) setPeople([]);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        function onKey(event: KeyboardEvent) {
            if (event.key === "Escape") onClose();
        }
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    const matched = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const all = people ?? [];
        if (!needle) return all;
        return all.filter(
            (person) =>
                person.displayName.toLowerCase().includes(needle) ||
                person.primaryEmail?.toLowerCase().includes(needle),
        );
    }, [people, query]);

    const matches = matched.slice(0, 8);

    // Asked of every match, not only the eight that fit: offering to create
    // somebody who already exists is how duplicate people get made, and the
    // exact one is not always ranked into view.
    const exactMatch = matched.some(
        (person) =>
            person.displayName.toLowerCase() === query.trim().toLowerCase(),
    );
    const canCreate = query.trim().length > 0 && !exactMatch;

    return (
        <div
            ref={containerRef}
            className="absolute z-40 mt-1 w-72 rounded-lg border bg-popover p-2 shadow-lg"
        >
            <div className="mb-2 flex items-center gap-2">
                <Input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && canCreate) {
                            onPick({ displayName: query.trim() });
                        }
                    }}
                    placeholder={`Who is ${label}?`}
                    aria-label={`Who is ${label}?`}
                    className="h-8 text-sm"
                />
                <Button
                    size="sm"
                    variant="ghost"
                    className="size-8 shrink-0 p-0"
                    onClick={onClose}
                    aria-label="Close"
                >
                    <X className="size-4" />
                </Button>
            </div>

            {people === null ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                    Loading people…
                </p>
            ) : (
                <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                    {matches.map((person) => (
                        <li key={person.id}>
                            <button
                                type="button"
                                onClick={() => onPick({ personId: person.id })}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                            >
                                <span className="min-w-0 flex-1 truncate">
                                    {person.displayName}
                                </span>
                                {person.id === personId && (
                                    <Check className="size-3.5 shrink-0 text-primary" />
                                )}
                            </button>
                        </li>
                    ))}

                    {canCreate && (
                        <li>
                            <button
                                type="button"
                                onClick={() =>
                                    onPick({ displayName: query.trim() })
                                }
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                            >
                                <UserPlus className="size-3.5 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate">
                                    Add “{query.trim()}”
                                </span>
                            </button>
                        </li>
                    )}

                    {matches.length === 0 && !canCreate && (
                        <li className="px-2 py-3 text-xs text-muted-foreground">
                            Nobody yet. Type a name to add one.
                        </li>
                    )}
                </ul>
            )}

            {personId && (
                <button
                    type="button"
                    onClick={onClear}
                    className="mt-2 w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    Leave unknown
                </button>
            )}
        </div>
    );
}
