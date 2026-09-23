"use client";

import {
    ArrowLeft,
    AudioLines,
    ChevronRight,
    Mail,
    Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted, useLocale } from "next-intl";
import { useMemo, useState } from "react";
import { PersonActions } from "@/components/people/person-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format-date";
import { formatSpeakerLabel } from "@/lib/transcription/diarization";
import { initials } from "@/lib/utils";

export interface PersonAppearance {
    recordingId: string;
    title: string;
    /** ISO 8601 timestamp. */
    recordedAt: string;
    /** The raw provider label being named, e.g. `speaker_0`. */
    label: string;
    status: string;
    source: string;
    /** Where the name was given: the owner's transcript or the Organization view. */
    view?: "private" | "org";
}

export interface PersonDetailProps {
    person: {
        id: string;
        displayName: string;
        primaryEmail: string | null;
        notes: string | null;
        scope?: "personal" | "org";
    };
    appearances: PersonAppearance[];
    /** Whether the viewer may rename, merge or erase this person. */
    canManage?: boolean;
}

export function PersonDetail({
    person,
    appearances,
    canManage = true,
}: PersonDetailProps) {
    const i18n = useExtracted();
    const locale = useLocale();
    const router = useRouter();
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    // One recording can hold two transcripts -- the user's own and a Plaud
    // import -- and the same person can be attributed in both, so the overlay
    // answers twice for one appearance. This page lists recordings, so each
    // is shown, keyed and counted once, which is also how `/people` counts.
    const heard = useMemo(() => {
        const byRecording = new Map<string, PersonAppearance>();
        for (const appearance of appearances) {
            if (!byRecording.has(appearance.recordingId)) {
                byRecording.set(appearance.recordingId, appearance);
            }
        }
        return [...byRecording.values()];
    }, [appearances]);

    async function erase() {
        const response = await fetch(`/api/people/${person.id}`, {
            method: "DELETE",
        });
        if (response.ok) {
            router.push("/people");
            router.refresh();
        }
    }

    return (
        <div className="space-y-8 pb-12">
            <Link
                href="/people"
                className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
                <ArrowLeft className="size-4" /> {i18n("People")}
            </Link>

            <header className="flex items-start gap-4">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
                    {initials(person.displayName)}
                </span>
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-2xl font-semibold">
                        {person.displayName}
                    </h1>
                    {person.primaryEmail && (
                        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                            <Mail className="size-3.5" />
                            {person.primaryEmail}
                        </p>
                    )}
                    <p className="mt-1 text-sm text-muted-foreground">
                        {i18n(
                            "Heard in {count, plural, one {# recording} other {# recordings}}",
                            { count: heard.length },
                        )}
                        {person.scope === "org" && ` · ${i18n("Organization")}`}
                    </p>
                </div>
                {canManage && !confirmingDelete && (
                    <div className="flex flex-wrap justify-end gap-2">
                        <PersonActions person={person} />
                    </div>
                )}
                {!canManage ? null : confirmingDelete ? (
                    <div className="flex shrink-0 items-center gap-2">
                        <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => void erase()}
                        >
                            {i18n("Erase")}
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmingDelete(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                    </div>
                ) : (
                    <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => setConfirmingDelete(true)}
                    >
                        <Trash2 className="mr-2 size-4" /> {i18n("Erase")}
                    </Button>
                )}
            </header>

            {confirmingDelete && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    {i18n(
                        "Erasing removes this person and every attribution pointing at them. The recordings and transcripts stay; their turns go back to showing the raw speaker label.",
                    )}
                </p>
            )}

            {person.notes && (
                <section className="space-y-2">
                    <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {i18n("Notes")}
                    </h2>
                    <p className="whitespace-pre-wrap text-sm">
                        {person.notes}
                    </p>
                </section>
            )}

            <Card>
                <CardHeader className="border-b">
                    <div className="flex items-center justify-between gap-3">
                        <CardTitle className="flex items-center gap-2">
                            <AudioLines className="size-5 text-primary" />{" "}
                            {i18n("Recordings")}
                        </CardTitle>
                        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                            {heard.length}
                        </span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                        {i18n(
                            "Recordings where this person has been identified as a speaker.",
                        )}
                    </p>
                </CardHeader>
                {heard.length === 0 ? (
                    <CardContent className="py-10 text-center text-sm text-muted-foreground">
                        {i18n(
                            "Not attributed to any recording yet. Open a diarized transcript and name one of its speakers.",
                        )}
                    </CardContent>
                ) : (
                    <CardContent className="p-0">
                        <ul className="divide-y">
                            {heard.map((appearance) => (
                                <li key={appearance.recordingId}>
                                    <Link
                                        href={
                                            appearance.view === "org"
                                                ? `/dashboard?recording=${encodeURIComponent(appearance.recordingId)}&view=org`
                                                : `/recordings/${appearance.recordingId}`
                                        }
                                        className="group flex items-center gap-3 px-5 py-4 transition-colors hover:bg-muted/40"
                                    >
                                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30 text-muted-foreground transition-colors group-hover:text-primary">
                                            <AudioLines className="size-4" />
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-medium">
                                                {appearance.title}
                                            </span>
                                            <span className="mt-0.5 block text-xs text-muted-foreground">
                                                {formatSpeakerLabel(
                                                    appearance.label,
                                                )}
                                                {appearance.status !==
                                                    "confirmed" &&
                                                    i18n(" · suggested")}
                                                {" · "}
                                                {formatDateTime(
                                                    appearance.recordedAt,
                                                    "relative",
                                                    locale,
                                                )}
                                            </span>
                                        </span>
                                        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </CardContent>
                )}
            </Card>
        </div>
    );
}
