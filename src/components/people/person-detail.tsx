"use client";

import { ArrowLeft, Mail, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format-date";
import { formatSpeakerLabel } from "@/lib/transcription/diarization";
import { initials } from "@/lib/utils";

export interface PersonAppearance {
    recordingId: string;
    title: string;
    recordedAt: string;
    label: string;
    status: string;
    source: string;
}

export interface PersonDetailProps {
    person: {
        id: string;
        displayName: string;
        primaryEmail: string | null;
        notes: string | null;
    };
    appearances: PersonAppearance[];
}

export function PersonDetail({ person, appearances }: PersonDetailProps) {
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
                <ArrowLeft className="size-4" />
                People
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
                        {heard.length === 1
                            ? "Heard in 1 recording"
                            : `Heard in ${heard.length} recordings`}
                    </p>
                </div>
                {confirmingDelete ? (
                    <div className="flex shrink-0 items-center gap-2">
                        <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => void erase()}
                        >
                            Erase
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmingDelete(false)}
                        >
                            Cancel
                        </Button>
                    </div>
                ) : (
                    <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => setConfirmingDelete(true)}
                    >
                        <Trash2 className="mr-2 size-4" />
                        Erase
                    </Button>
                )}
            </header>

            {confirmingDelete && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    Erasing removes this person and every attribution pointing
                    at them. The recordings and transcripts stay; their turns go
                    back to showing the raw speaker label.
                </p>
            )}

            {person.notes && (
                <section className="space-y-2">
                    <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Notes
                    </h2>
                    <p className="whitespace-pre-wrap text-sm">
                        {person.notes}
                    </p>
                </section>
            )}

            <section className="space-y-2">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Appears in
                </h2>
                {heard.length === 0 ? (
                    <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
                        Not attributed to any recording yet. Open a diarized
                        transcript and name one of its speakers.
                    </p>
                ) : (
                    <ul className="divide-y rounded-lg border">
                        {heard.map((appearance) => (
                            <li key={appearance.recordingId}>
                                <Link
                                    href={`/recordings/${appearance.recordingId}`}
                                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm font-medium">
                                            {appearance.title}
                                        </span>
                                        <span className="block text-xs text-muted-foreground">
                                            {formatSpeakerLabel(
                                                appearance.label,
                                            )}
                                            {appearance.status !==
                                                "confirmed" && " · suggested"}
                                        </span>
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {formatDateTime(appearance.recordedAt)}
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
