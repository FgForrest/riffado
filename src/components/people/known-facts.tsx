"use client";

import {
    Building2,
    Mail,
    Pencil,
    Play,
    Plus,
    Trash2,
    UserRound,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted, useLocale } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
    FactDialog,
    type FactRelation,
} from "@/components/almanac/fact-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getApiErrorMessage } from "@/lib/api-errors";
import { formatDateTime } from "@/lib/format-date";
import type {
    FactSide,
    PageEvidence,
    PageFact,
    PageRelation,
} from "@/lib/knowledge/fact-page";

function timestamp(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const pad = (value: number) => value.toString().padStart(2, "0");
    return hours > 0
        ? `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}`
        : `${minutes}:${pad(seconds % 60)}`;
}

function recordingHref(evidence: PageEvidence): string {
    if (evidence.view === "org") {
        return `/dashboard?recording=${encodeURIComponent(evidence.recordingId)}&view=org`;
    }
    // A mail opens in the pile; the recording page is for audio.
    return evidence.kind === "mail"
        ? `/dashboard?recording=${encodeURIComponent(evidence.recordingId)}`
        : `/recordings/${evidence.recordingId}`;
}

function Side({ side }: { side: FactSide }) {
    if (side.kind === "literal" || !side.id) {
        return <span className="font-medium">{side.text}</span>;
    }
    const href =
        side.kind === "person"
            ? `/almanac/${side.id}`
            : `/almanac/things/${side.id}`;
    const Icon = side.kind === "person" ? UserRound : Building2;
    return (
        <Link
            href={href}
            className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
        >
            <Icon className="size-3.5 text-muted-foreground" />
            {side.text}
        </Link>
    );
}

/** What the viewer may change on a page's facts. */
export interface FactEditing {
    subject: { kind: "person" | "entity"; id: string; typeKey: string };
    relations: readonly FactRelation[];
    typeLabels: Record<string, string>;
    /** The scope of the viewer's own facts: the Organization's for its account. */
    ownScope: "personal" | "org";
}

/**
 * What is known about a person or an entity, by relation and direction:
 * under "leads", what `name` leads; under "reports to <name>", who reports
 * to them. Each fact with where it was said or written (▸ opens the
 * recording or the mail; a mail's quoted part is marked as an earlier
 * writer's), how many recordings and mails support it and when it was last
 * said. Only what the viewer may read reaches here (`factsForPage`).
 */
export function KnownFacts({
    name,
    relations,
    editing,
}: {
    /** The page's person or entity. */
    name: string;
    relations: PageRelation[];
    /** Absent: read only. */
    editing?: FactEditing;
}) {
    const i18n = useExtracted();
    const locale = useLocale();
    const router = useRouter();
    const [adding, setAdding] = useState(false);
    const [changing, setChanging] = useState<{
        factId: string;
        relationKey: string;
        other: PageFact["other"];
    } | null>(null);
    const [erasing, setErasing] = useState<string | null>(null);

    async function erase(factId: string) {
        const response = await fetch(`/api/knowledge/facts/${factId}`, {
            method: "DELETE",
        });
        setErasing(null);
        if (!response.ok) {
            toast.error(
                await getApiErrorMessage(
                    response,
                    i18n("Could not erase this fact"),
                ),
            );
            return;
        }
        router.refresh();
    }

    const dialogs = editing && (
        <>
            {adding && (
                <FactDialog
                    open
                    onOpenChange={setAdding}
                    subject={editing.subject}
                    relations={editing.relations}
                    typeLabels={editing.typeLabels}
                />
            )}
            {changing && (
                <FactDialog
                    open
                    onOpenChange={(open) => !open && setChanging(null)}
                    subject={editing.subject}
                    relations={editing.relations}
                    typeLabels={editing.typeLabels}
                    editing={{
                        factId: changing.factId,
                        relationKey: changing.relationKey,
                        other:
                            changing.other.kind === "literal" ||
                            !changing.other.id
                                ? { kind: "literal", text: changing.other.text }
                                : {
                                      kind: changing.other.kind,
                                      id: changing.other.id,
                                      name: changing.other.text,
                                  },
                    }}
                />
            )}
        </>
    );
    const addButton = editing && (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> {i18n("Add a fact")}
        </Button>
    );
    const groups = relations.flatMap((relation) =>
        (["subject", "object"] as const).flatMap((direction) => {
            const facts = relation.facts.filter(
                (fact) => fact.direction === direction,
            );
            return facts.length === 0
                ? []
                : [
                      {
                          key: `${relation.key}|${direction}`,
                          heading:
                              direction === "subject"
                                  ? relation.label
                                  : `${relation.label} ${name}`,
                          facts,
                      },
                  ];
        }),
    );

    if (groups.length === 0) {
        return (
            <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                    {i18n("Nothing is known yet.")}
                </p>
                {addButton}
                {dialogs}
            </div>
        );
    }

    return (
        <div className="space-y-5">
            {addButton}
            {dialogs}
            {groups.map((group) => (
                <section key={group.key} className="space-y-2">
                    <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {group.heading}
                    </h3>
                    <ul className="space-y-2">
                        {group.facts.map((fact) => {
                            const own =
                                editing !== undefined &&
                                fact.scope === editing.ownScope;
                            const relationKey = group.key.split("|")[0] ?? "";
                            const recordingsCount = new Set(
                                fact.evidence
                                    .filter((item) => item.kind === "audio")
                                    .map((item) => item.recordingId),
                            ).size;
                            const mailsCount = new Set(
                                fact.evidence
                                    .filter((item) => item.kind === "mail")
                                    .map((item) => item.recordingId),
                            ).size;
                            const latest = fact.evidence[0];
                            return (
                                <li
                                    key={fact.id}
                                    className="rounded-lg border px-3 py-2 text-sm"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <p className="min-w-0">
                                            <Side side={fact.other} />
                                        </p>
                                        {own &&
                                            (erasing === fact.id ? (
                                                <span className="flex shrink-0 gap-1">
                                                    <Button
                                                        size="sm"
                                                        variant="destructive"
                                                        className="h-7"
                                                        onClick={() =>
                                                            void erase(fact.id)
                                                        }
                                                    >
                                                        {i18n("Erase")}
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="h-7"
                                                        onClick={() =>
                                                            setErasing(null)
                                                        }
                                                    >
                                                        {i18n("Cancel")}
                                                    </Button>
                                                </span>
                                            ) : (
                                                <span className="flex shrink-0 gap-1">
                                                    {fact.direction ===
                                                        "subject" && (
                                                        <Button
                                                            size="icon"
                                                            variant="ghost"
                                                            className="size-7"
                                                            aria-label={i18n(
                                                                "Change fact",
                                                            )}
                                                            onClick={() =>
                                                                setChanging({
                                                                    factId: fact.id,
                                                                    relationKey,
                                                                    other: fact.other,
                                                                })
                                                            }
                                                        >
                                                            <Pencil className="size-3.5" />
                                                        </Button>
                                                    )}
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        className="size-7"
                                                        aria-label={i18n(
                                                            "Erase fact",
                                                        )}
                                                        onClick={() =>
                                                            setErasing(fact.id)
                                                        }
                                                    >
                                                        <Trash2 className="size-3.5" />
                                                    </Button>
                                                </span>
                                            ))}
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {fact.scope === "org"
                                            ? i18n("Organization")
                                            : i18n("Only you")}
                                        {" · "}
                                        {fact.origin === "manual" &&
                                        recordingsCount + mailsCount === 0
                                            ? i18n("Entered by hand")
                                            : mailsCount === 0
                                              ? i18n(
                                                    "Supported by {count, plural, one {# recording} other {# recordings}}",
                                                    { count: recordingsCount },
                                                )
                                              : recordingsCount === 0
                                                ? i18n(
                                                      "Supported by {count, plural, one {# mail} other {# mails}}",
                                                      { count: mailsCount },
                                                  )
                                                : i18n(
                                                      "Supported by {recordings, plural, one {# recording} other {# recordings}} and {mails, plural, one {# mail} other {# mails}}",
                                                      {
                                                          recordings:
                                                              recordingsCount,
                                                          mails: mailsCount,
                                                      },
                                                  )}
                                        {latest &&
                                            ` · ${i18n("last on {date}", {
                                                date: formatDateTime(
                                                    latest.recordedAt,
                                                    "absolute",
                                                    locale,
                                                ),
                                            })}`}
                                    </p>
                                    {fact.evidence.length > 0 && (
                                        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                                            {fact.evidence.map((evidence) => (
                                                <li
                                                    key={`${evidence.recordingId}-${evidence.startMs}`}
                                                >
                                                    <Link
                                                        href={recordingHref(
                                                            evidence,
                                                        )}
                                                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                                    >
                                                        {evidence.kind ===
                                                        "mail" ? (
                                                            <Mail className="size-3" />
                                                        ) : (
                                                            <Play className="size-3" />
                                                        )}
                                                        {evidence.title}
                                                        {evidence.startMs !==
                                                            null &&
                                                            ` ${timestamp(evidence.startMs)}`}
                                                    </Link>
                                                    {evidence.quoted && (
                                                        <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">
                                                            {i18n(
                                                                "quoted from an earlier message",
                                                            )}
                                                        </span>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ))}
        </div>
    );
}

/** A name a person or a thing is also known by. */
export interface OtherName {
    /** Present where the viewer may take the name back. */
    id?: string;
    text: string;
    kind: "alias" | "heard_as";
    scope?: "personal" | "org";
}

/**
 * Other names: nicknames people gave, and how transcription heard the
 * name. With `editing`, the viewer adds nicknames of their own and takes
 * back the ones they gave; how a name was heard goes with its correction.
 */
export function OtherNames({
    names,
    editing,
}: {
    names: OtherName[];
    editing?: {
        target: { personId: string } | { entityId: string };
        /** The scope of the viewer's own names. */
        ownScope: "personal" | "org";
    };
}) {
    const i18n = useExtracted();
    const router = useRouter();
    const [adding, setAdding] = useState(false);
    const [text, setText] = useState("");
    const [saving, setSaving] = useState(false);
    if (names.length === 0 && !editing) return null;
    const aliases = names.filter((name) => name.kind === "alias");
    const heardAs = names.filter((name) => name.kind === "heard_as");

    async function add() {
        if (!editing || !text.trim()) return;
        setSaving(true);
        try {
            const response = await fetch("/api/knowledge/aliases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    target: editing.target,
                    text: text.trim(),
                }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not add this nickname"),
                    ),
                );
                return;
            }
            setText("");
            setAdding(false);
            router.refresh();
        } finally {
            setSaving(false);
        }
    }

    async function remove(id: string) {
        const response = await fetch(`/api/knowledge/aliases/${id}`, {
            method: "DELETE",
        });
        if (!response.ok) {
            toast.error(
                await getApiErrorMessage(
                    response,
                    i18n("Could not remove this nickname"),
                ),
            );
            return;
        }
        router.refresh();
    }

    return (
        <section className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {i18n("Also known as")}
            </h2>
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
                {aliases.map((name) =>
                    editing && name.id && name.scope === editing.ownScope ? (
                        <span
                            key={name.id}
                            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
                        >
                            {name.text}
                            <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground"
                                aria-label={i18n("Remove {name}", {
                                    name: name.text,
                                })}
                                onClick={() => void remove(name.id as string)}
                            >
                                ×
                            </button>
                        </span>
                    ) : (
                        <span
                            key={name.id ?? name.text}
                            className="rounded-full border px-2 py-0.5"
                        >
                            {name.text}
                        </span>
                    ),
                )}
                {heardAs.length > 0 && (
                    <span className="text-muted-foreground">
                        {i18n("heard as {names}", {
                            names: heardAs.map((name) => name.text).join(", "),
                        })}
                    </span>
                )}
                {editing &&
                    (adding ? (
                        <form
                            className="inline-flex items-center gap-1"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void add();
                            }}
                        >
                            <Input
                                autoFocus
                                value={text}
                                maxLength={200}
                                onChange={(event) =>
                                    setText(event.target.value)
                                }
                                onKeyDown={(event) => {
                                    if (event.key === "Escape")
                                        setAdding(false);
                                }}
                                aria-label={i18n("New nickname")}
                                className="h-7 w-40"
                            />
                            <Button
                                type="submit"
                                size="sm"
                                className="h-7"
                                disabled={saving || !text.trim()}
                            >
                                {i18n("Add")}
                            </Button>
                        </form>
                    ) : (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-7"
                            onClick={() => setAdding(true)}
                        >
                            <Plus className="size-3.5" />{" "}
                            {i18n("Add a nickname")}
                        </Button>
                    ))}
            </div>
        </section>
    );
}
