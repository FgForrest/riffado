"use client";

import { Loader2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SpeakerPicker } from "@/components/people/speaker-picker";
import { toastApiError } from "@/lib/api-errors";
import {
    type SpeakerAttributions,
    speakerAnchorId,
} from "@/lib/knowledge/speaker-references";

const SPEAKER_ACCENTS = [
    "bg-primary",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-violet-500",
    "bg-rose-500",
    "bg-sky-500",
] as const;

export interface TranscriptSpeakerTag {
    speaker: string;
    label: string;
}

interface SpeakerTagsProps {
    recordingId: string;
    source: string;
    speakers: TranscriptSpeakerTag[];
    onAttributionsChange: (attributions: SpeakerAttributions) => void;
}

interface SpeakerResponseRow {
    label: string;
    personId: string | null;
    personName: string | null;
    status: string;
}

function confirmedAttributions(
    speakers: SpeakerResponseRow[] | undefined,
): SpeakerAttributions {
    const confirmed: Record<string, { personId: string; name: string }> = {};
    for (const speaker of speakers ?? []) {
        if (speaker.status !== "confirmed") continue;
        if (!speaker.personId || !speaker.personName) continue;
        confirmed[speaker.label] = {
            personId: speaker.personId,
            name: speaker.personName,
        };
    }
    return confirmed;
}

/** Editable participant tags for the currently selected transcript. */
export function SpeakerTags({
    recordingId,
    source,
    speakers,
    onAttributionsChange,
}: SpeakerTagsProps) {
    const attributionKey = `${recordingId}:${source}`;
    const [attributionState, setAttributionState] = useState<{
        key: string;
        values: SpeakerAttributions;
    }>({ key: "", values: {} });
    const attributions =
        attributionState.key === attributionKey ? attributionState.values : {};
    const [openLabel, setOpenLabel] = useState<string | null>(null);
    const [savingLabel, setSavingLabel] = useState<string | null>(null);

    const applyAttributions = useCallback(
        (next: SpeakerAttributions) => {
            setAttributionState({ key: attributionKey, values: next });
            onAttributionsChange(next);
        },
        [attributionKey, onAttributionsChange],
    );

    useEffect(() => {
        let cancelled = false;
        setOpenLabel(null);

        void fetch(
            `/api/recordings/${recordingId}/speakers?source=${encodeURIComponent(source)}`,
        )
            .then(async (response) => {
                if (!response.ok) return null;
                return (await response.json()) as {
                    speakers?: SpeakerResponseRow[];
                };
            })
            .then((body) => {
                if (!cancelled && body) {
                    applyAttributions(confirmedAttributions(body.speakers));
                }
            })
            .catch(() => {});

        return () => {
            cancelled = true;
        };
    }, [applyAttributions, recordingId, source]);

    async function attribute(
        label: string,
        choice: { personId?: string; displayName?: string } | null,
    ): Promise<boolean> {
        setSavingLabel(label);
        const response = await fetch(
            `/api/recordings/${recordingId}/speakers?source=${encodeURIComponent(source)}`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ label, ...(choice ?? {}) }),
            },
        ).catch(() => null);
        setSavingLabel(null);

        if (!response) {
            toast.error("Could not reach the server");
            return false;
        }
        if (!response.ok) {
            await toastApiError(response, {
                fallback: choice
                    ? "Failed to identify this speaker"
                    : "Failed to unlink this speaker",
                errorContext: "update a transcript speaker",
            });
            return false;
        }

        const body = (await response.json()) as {
            speakers?: SpeakerResponseRow[];
        };
        applyAttributions(confirmedAttributions(body.speakers));
        return true;
    }

    if (speakers.length === 0) return null;

    const openSpeaker = speakers.find(
        (speaker) => speaker.speaker === openLabel,
    );

    return (
        <fieldset
            className="flex flex-wrap items-center gap-2 border-t pt-3"
            aria-label="Transcript speakers"
        >
            {speakers.map((speaker, index) => {
                const attribution = attributions[speaker.speaker];
                const saving = savingLabel === speaker.speaker;
                const accent = SPEAKER_ACCENTS[index % SPEAKER_ACCENTS.length];

                if (!attribution) {
                    return (
                        <button
                            key={speaker.speaker}
                            id={speakerAnchorId(speaker.speaker)}
                            type="button"
                            onClick={() => setOpenLabel(speaker.speaker)}
                            disabled={saving}
                            className="inline-flex h-8 items-center gap-2 rounded-full border bg-muted/30 px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-foreground disabled:opacity-60"
                        >
                            <span
                                className={`size-1.5 rounded-full ${accent}`}
                            />
                            {speaker.label}
                            {saving && (
                                <Loader2 className="size-3 animate-spin" />
                            )}
                        </button>
                    );
                }

                return (
                    <span
                        key={speaker.speaker}
                        id={speakerAnchorId(speaker.speaker)}
                        className="inline-flex h-8 items-center overflow-hidden rounded-full border border-primary/30 bg-primary/10 text-xs font-medium"
                    >
                        <Link
                            href={`/people/${attribution.personId}`}
                            className="inline-flex h-full items-center gap-2 pl-3 pr-2 transition-colors hover:bg-primary/10"
                        >
                            <span
                                className={`size-1.5 rounded-full ${accent}`}
                            />
                            {attribution.name}
                        </Link>
                        <button
                            type="button"
                            onClick={() =>
                                void attribute(speaker.speaker, null)
                            }
                            disabled={saving}
                            aria-label={`Unlink ${attribution.name} from ${speaker.label}`}
                            title={`Unlink ${attribution.name}`}
                            className="flex h-full items-center border-l border-primary/20 px-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                        >
                            {saving ? (
                                <Loader2 className="size-3 animate-spin" />
                            ) : (
                                <X className="size-3" />
                            )}
                        </button>
                    </span>
                );
            })}

            {openSpeaker && (
                <SpeakerPicker
                    label={openSpeaker.label}
                    onPick={(choice) => attribute(openSpeaker.speaker, choice)}
                    onClose={() => setOpenLabel(null)}
                />
            )}
        </fieldset>
    );
}
