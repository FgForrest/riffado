"use client";

import { Plus, Search, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format-date";
import { initials } from "@/lib/utils";

export interface PersonSummary {
    id: string;
    displayName: string;
    primaryEmail: string | null;
    recordingCount: number;
    /** ISO 8601 timestamp, or null if the person has no confirmed appearance yet. */
    lastSeen: string | null;
}

export function PeopleList({ people }: { people: PersonSummary[] }) {
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
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
        if (!displayName) return;
        const response = await fetch("/api/people", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ displayName }),
        });
        if (response.ok) {
            setNewName("");
            setCreating(false);
            router.refresh();
        }
    }

    if (people.length === 0 && !creating) {
        return (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
                <Users className="size-8 text-muted-foreground" />
                <p className="text-sm font-medium">No people yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                    Name a speaker in any diarized transcript and they will
                    appear here. Everyone you have named is remembered across
                    recordings.
                </p>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCreating(true)}
                >
                    <Plus className="mr-2 size-4" />
                    Add someone
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-4 pb-12">
            <div className="flex items-center gap-2">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search people"
                        className="pl-9"
                        aria-label="Search people"
                    />
                </div>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCreating((open) => !open)}
                >
                    <Plus className="mr-2 size-4" />
                    Add
                </Button>
            </div>

            {creating && (
                <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3">
                    <Input
                        autoFocus
                        value={newName}
                        onChange={(event) => setNewName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void createPerson();
                            if (event.key === "Escape") setCreating(false);
                        }}
                        placeholder="Full name"
                        aria-label="Name of the person to add"
                    />
                    <Button size="sm" onClick={() => void createPerson()}>
                        Add
                    </Button>
                </div>
            )}

            <ul className="divide-y rounded-lg border">
                {filtered.map((person) => (
                    <li key={person.id}>
                        <Link
                            href={`/people/${person.id}`}
                            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                        >
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                                {initials(person.displayName)}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">
                                    {person.displayName}
                                </span>
                                {person.primaryEmail && (
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {person.primaryEmail}
                                    </span>
                                )}
                            </span>
                            <span className="shrink-0 text-right text-xs text-muted-foreground">
                                <span className="block">
                                    {person.recordingCount === 1
                                        ? "1 recording"
                                        : `${person.recordingCount} recordings`}
                                </span>
                                {person.lastSeen && (
                                    <span className="block">
                                        {formatDateTime(person.lastSeen)}
                                    </span>
                                )}
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>

            {filtered.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                    Nobody matches “{query}”.
                </p>
            )}
        </div>
    );
}
