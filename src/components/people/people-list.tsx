"use client";

import { ChevronRight, Plus, Search, UsersRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted, useLocale } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { AppNav } from "@/components/app-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format-date";
import { initials } from "@/lib/utils";

export interface PersonSummary {
    id: string;
    displayName: string;
    primaryEmail: string | null;
    /** `org` for a person the whole Organization shares. */
    scope?: "personal" | "org";
    recordingCount: number;
    /** ISO 8601 timestamp, or null if the person has no confirmed appearance yet. */
    lastSeen: string | null;
}

export function PeopleList({ people }: { people: PersonSummary[] }) {
    const i18n = useExtracted();
    const locale = useLocale();
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const [saving, setSaving] = useState(false);
    const [newName, setNewName] = useState("");

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return people;
        return people.filter(
            (person) =>
                person.displayName.toLowerCase().includes(needle) ||
                person.primaryEmail?.toLowerCase().includes(needle),
        );
    }, [people, query]);

    async function createPerson() {
        const displayName = newName.trim();
        if (!displayName || saving) return;

        setSaving(true);
        try {
            const response = await fetch("/api/people", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ displayName }),
            });
            if (!response.ok) {
                throw new Error(i18n("Could not add this person"));
            }

            setNewName("");
            setCreating(false);
            router.refresh();
            toast.success(i18n("{name} added", { name: displayName }));
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not add this person"),
            );
        } finally {
            setSaving(false);
        }
    }

    function closeCreator() {
        setCreating(false);
        setNewName("");
    }

    const creatorForm = (
        <form
            className="flex w-full flex-col gap-3 rounded-xl border border-primary/20 bg-primary/[0.04] p-4 text-left shadow-sm sm:flex-row sm:items-end"
            onSubmit={(event) => {
                event.preventDefault();
                void createPerson();
            }}
        >
            <label className="min-w-0 flex-1" htmlFor="person-display-name">
                <span className="mb-2 block text-sm font-medium">
                    {i18n("Who would you like to remember?")}
                </span>
                <Input
                    id="person-display-name"
                    autoFocus
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") closeCreator();
                    }}
                    placeholder={i18n("Full name")}
                    aria-label={i18n("Name of the person to add")}
                    className="bg-background"
                />
            </label>
            <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={closeCreator}>
                    {i18n("Cancel")}
                </Button>
                <Button type="submit" disabled={!newName.trim() || saving}>
                    {saving ? i18n("Adding…") : i18n("Add person")}
                </Button>
            </div>
        </form>
    );

    return (
        <>
            <AppHeader>
                <AppNav className="min-w-0" />
                <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-9"
                    onClick={() =>
                        creating ? closeCreator() : setCreating(true)
                    }
                    aria-expanded={creating}
                >
                    <Plus className="size-4" />
                    <span className="hidden sm:inline">
                        {creating ? i18n("Cancel") : i18n("Add person")}
                    </span>
                    <span className="sm:hidden">
                        {creating ? i18n("Cancel") : i18n("Add")}
                    </span>
                </Button>
            </AppHeader>

            <div className="space-y-5 pb-12">
                {people.length === 0 ? (
                    <section className="relative isolate overflow-hidden rounded-2xl border bg-card px-6 py-16 text-center shadow-sm sm:py-20">
                        <div
                            aria-hidden="true"
                            className="absolute left-1/2 top-0 -z-10 size-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-3xl"
                        />
                        <div className="mx-auto flex max-w-lg flex-col items-center">
                            <div className="mb-5 grid size-16 place-items-center rounded-2xl border bg-background shadow-sm">
                                <UsersRound className="size-7 text-primary" />
                            </div>
                            <p className="mb-3 rounded-full border bg-background/80 px-3 py-1 text-xs font-medium text-foreground/70 shadow-xs">
                                {i18n("Speaker memory")}
                            </p>
                            <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
                                {i18n("Put a name to every voice")}
                            </h1>
                            <p className="mt-3 max-w-md text-pretty text-sm leading-6 text-foreground/70 sm:text-base">
                                {i18n(
                                    "Name a speaker once and Riffado remembers them across recordings, keeping every conversation easier to follow.",
                                )}
                            </p>
                            <div className="mt-7 w-full">
                                {creating ? (
                                    creatorForm
                                ) : (
                                    <Button onClick={() => setCreating(true)}>
                                        <Plus className="size-4" />{" "}
                                        {i18n("Add your first person")}
                                    </Button>
                                )}
                            </div>
                        </div>
                    </section>
                ) : (
                    <>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                            <div>
                                <p className="text-sm font-medium">
                                    {i18n(
                                        "{count, plural, one {# person} other {# people}}",
                                        { count: people.length },
                                    )}
                                </p>
                                <p className="mt-1 text-sm text-foreground/70">
                                    {i18n(
                                        "Familiar speakers remembered across your recordings.",
                                    )}
                                </p>
                            </div>
                            <div className="relative w-full sm:max-w-sm">
                                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={query}
                                    onChange={(event) =>
                                        setQuery(event.target.value)
                                    }
                                    placeholder={i18n("Search people")}
                                    className="bg-card pl-9 shadow-xs"
                                    aria-label={i18n("Search people")}
                                />
                            </div>
                        </div>

                        {creating && creatorForm}

                        {filtered.length > 0 && (
                            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                {filtered.map((person) => (
                                    <li key={person.id}>
                                        <Link
                                            href={`/people/${person.id}`}
                                            className="group flex h-full min-h-40 flex-col rounded-xl border bg-card p-4 shadow-sm transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            <span className="flex items-start justify-between gap-3">
                                                <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary ring-1 ring-primary/15">
                                                    {initials(
                                                        person.displayName,
                                                    )}
                                                </span>
                                                <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                                            </span>
                                            <span className="mt-4 min-w-0">
                                                <span className="block truncate font-medium">
                                                    {person.displayName}
                                                </span>
                                                {person.scope === "org" && (
                                                    <span className="mt-1 inline-block rounded-full border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                                                        {i18n("Organization")}
                                                    </span>
                                                )}
                                                <span className="mt-1 block truncate text-xs text-foreground/70">
                                                    {person.primaryEmail ??
                                                        i18n("No email added")}
                                                </span>
                                            </span>
                                            <span className="mt-auto flex items-end justify-between gap-3 pt-5 text-xs text-foreground/70">
                                                <span>
                                                    {i18n(
                                                        "{count, plural, one {# recording} other {# recordings}}",
                                                        {
                                                            count: person.recordingCount,
                                                        },
                                                    )}
                                                </span>
                                                {person.lastSeen && (
                                                    <span className="truncate text-right">
                                                        {formatDateTime(
                                                            person.lastSeen,
                                                            "relative",
                                                            locale,
                                                        )}
                                                    </span>
                                                )}
                                            </span>
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        )}

                        {filtered.length === 0 && (
                            <div className="rounded-xl border bg-card px-6 py-12 text-center shadow-sm">
                                <Search className="mx-auto size-6 text-muted-foreground" />
                                <p className="mt-3 text-sm font-medium">
                                    {i18n("No matching people")}
                                </p>
                                <p className="mt-1 text-sm text-foreground/70">
                                    {i18n(
                                        "Nobody matches “{query}”. Try another name or email.",
                                        { query },
                                    )}
                                </p>
                            </div>
                        )}
                    </>
                )}
            </div>
        </>
    );
}
