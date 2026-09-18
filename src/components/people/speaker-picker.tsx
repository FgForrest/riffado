"use client";

import { Check, Loader2, Search, UserPlus } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface PickablePerson {
    id: string;
    displayName: string;
    primaryEmail: string | null;
}

export interface SpeakerPickerProps {
    /** The raw provider label being named, e.g. `speaker_0`. */
    label: string;
    /** Resolves true only after the attribution was persisted. */
    onPick: (choice: {
        personId?: string;
        displayName?: string;
    }) => Promise<boolean>;
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
export function SpeakerPicker({ label, onPick, onClose }: SpeakerPickerProps) {
    const i18n = useExtracted();
    const [people, setPeople] = useState<PickablePerson[] | null>(null);
    const [query, setQuery] = useState("");
    const [selectedPersonId, setSelectedPersonId] = useState<string | null>(
        null,
    );
    const [submitting, setSubmitting] = useState(false);

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
    const exactMatch = (people ?? []).find(
        (person) =>
            person.displayName.toLowerCase() === query.trim().toLowerCase(),
    );
    const selectedPerson = (people ?? []).find(
        (person) => person.id === selectedPersonId,
    );
    const personToSelect = selectedPerson ?? exactMatch;
    const trimmedQuery = query.trim();
    const canSubmit = Boolean(personToSelect || trimmedQuery);
    const createsPerson = canSubmit && !personToSelect;

    async function submit() {
        if (!canSubmit || submitting) return;
        setSubmitting(true);
        const saved = await onPick(
            personToSelect
                ? { personId: personToSelect.id }
                : { displayName: trimmedQuery },
        );
        setSubmitting(false);
        if (saved) onClose();
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {i18n("Identify {speaker}", { speaker: label })}
                    </DialogTitle>
                    <DialogDescription>
                        {i18n("Select an existing person or enter a new name.")}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-2">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            autoFocus
                            role="combobox"
                            aria-controls="speaker-person-options"
                            aria-expanded={matches.length > 0}
                            value={query}
                            onChange={(event) => {
                                setQuery(event.target.value);
                                setSelectedPersonId(null);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && canSubmit) {
                                    event.preventDefault();
                                    void submit();
                                }
                            }}
                            placeholder={i18n("Search people or enter a name")}
                            aria-label={i18n("Who is {speaker}?", {
                                speaker: label,
                            })}
                            className="pl-9"
                        />
                    </div>

                    <div className="min-h-20 rounded-md border bg-muted/20 p-1">
                        {people === null ? (
                            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                                {i18n("Loading people…")}
                            </p>
                        ) : matches.length > 0 ? (
                            <ul
                                id="speaker-person-options"
                                className="max-h-56 space-y-0.5 overflow-y-auto"
                            >
                                {matches.map((person) => {
                                    const selected =
                                        person.id === personToSelect?.id;
                                    return (
                                        <li key={person.id}>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setSelectedPersonId(
                                                        person.id,
                                                    );
                                                    setQuery(
                                                        person.displayName,
                                                    );
                                                }}
                                                className="flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                                            >
                                                <span
                                                    aria-hidden="true"
                                                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-background text-xs font-medium"
                                                >
                                                    {person.displayName
                                                        .slice(0, 1)
                                                        .toUpperCase()}
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate font-medium">
                                                        {person.displayName}
                                                    </span>
                                                    {person.primaryEmail && (
                                                        <span className="block truncate text-xs text-muted-foreground">
                                                            {
                                                                person.primaryEmail
                                                            }
                                                        </span>
                                                    )}
                                                </span>
                                                {selected && (
                                                    <Check className="size-4 shrink-0 text-primary" />
                                                )}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        ) : (
                            <div className="flex min-h-20 items-center justify-center gap-2 px-3 py-5 text-sm text-muted-foreground">
                                {trimmedQuery ? (
                                    <>
                                        <UserPlus className="size-4" />{" "}
                                        {i18n("Create “{name}”", {
                                            name: trimmedQuery,
                                        })}
                                    </>
                                ) : (
                                    i18n(
                                        "No people yet. Enter a name to create one.",
                                    )
                                )}
                            </div>
                        )}
                    </div>
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={onClose}
                        disabled={submitting}
                    >
                        {i18n("Cancel")}
                    </Button>
                    <Button
                        onClick={() => void submit()}
                        disabled={!canSubmit || submitting}
                    >
                        {submitting && (
                            <Loader2 className="mr-2 size-4 animate-spin" />
                        )}
                        {createsPerson ? i18n("Create") : i18n("Select")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
