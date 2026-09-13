"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SpeakerPicker } from "@/components/people/speaker-picker";
import {
    formatSpeakerLabel,
    mayBeDiarized,
    parseSpeakerTurns,
    speakerOrder,
} from "@/lib/transcription/diarization";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/**
 * Per-speaker accents. Cycles when a recording has more speakers than
 * colours, which is rare and still readable: adjacent turns keep their labels.
 */
const SPEAKER_STYLES = [
    { dot: "bg-primary", text: "text-primary" },
    { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
    { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
    { dot: "bg-violet-500", text: "text-violet-600 dark:text-violet-400" },
    { dot: "bg-rose-500", text: "text-rose-600 dark:text-rose-400" },
    { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400" },
];

export interface TranscriptViewProps {
    text: string;
    /** Transcript provenance, used to decide whether to look for speakers. */
    source?: string | null;
    model?: string | null;
    /**
     * Turns as the provider reported them. Preferred over re-deriving them
     * from the text: the provider's own grouping is authoritative, and only
     * these carry timings. Absent for transcripts written before turns were
     * stored, which fall back to the regex.
     */
    storedTurns?: TranscriptTurn[] | null;
    /**
     * Enables naming. Without a recording to attribute against, labels render
     * as plain text -- which is what the dashboard preview wants.
     */
    recordingId?: string;
}

/**
 * A transcript, rendered as a dialog when it has speaker turns to show and as
 * plain text otherwise.
 *
 * The dialog is gated twice. `mayBeDiarized` asks whether this transcript came
 * from a path that emits speaker labels, so an undiarized transcript that
 * happens to contain a line like "Note: ..." is never examined.
 * `parseSpeakerTurns` then asks whether labels actually arrived, because a
 * diarizing model can still answer with one unlabelled block.
 */
export function TranscriptView({
    text,
    source,
    model,
    storedTurns,
    recordingId,
}: TranscriptViewProps) {
    // Confirmed names for this transcript, fetched rather than threaded
    // through the loaders: there are two of those and an attribution changes
    // far more often than a page load.
    const [names, setNames] = useState<Record<string, string>>({});
    const [openLabel, setOpenLabel] = useState<string | null>(null);
    const attributable = Boolean(recordingId) && Boolean(source);

    const loadNames = useCallback(async () => {
        if (!recordingId || !source) return;
        const response = await fetch(
            `/api/recordings/${recordingId}/speakers?source=${encodeURIComponent(source)}`,
        );
        if (!response.ok) return;
        const body = (await response.json()) as {
            speakers?: {
                label: string;
                personName: string | null;
                status: string;
            }[];
        };
        setNames(
            Object.fromEntries(
                (body.speakers ?? [])
                    .filter(
                        (speaker) =>
                            speaker.personName &&
                            speaker.status === "confirmed",
                    )
                    .map((speaker) => [
                        speaker.label,
                        speaker.personName as string,
                    ]),
            ),
        );
    }, [recordingId, source]);

    useEffect(() => {
        if (attributable) void loadNames();
    }, [attributable, loadNames]);

    async function attribute(
        label: string,
        choice: { personId?: string; displayName?: string } | null,
    ) {
        if (!recordingId || !source) return;
        await fetch(
            `/api/recordings/${recordingId}/speakers?source=${encodeURIComponent(source)}`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ label, ...(choice ?? {}) }),
            },
        );
        setOpenLabel(null);
        await loadNames();
    }

    const turns = useMemo(() => {
        if (storedTurns?.length) {
            return storedTurns.map((turn) => ({
                speaker: turn.speaker,
                label: formatSpeakerLabel(turn.speaker),
                text: turn.text,
            }));
        }
        if (!mayBeDiarized({ source, model })) return null;
        return parseSpeakerTurns(text);
    }, [text, source, model, storedTurns]);

    if (!turns) {
        return (
            <p className="text-sm whitespace-pre-wrap leading-relaxed">
                {text}
            </p>
        );
    }

    const order = speakerOrder(turns);

    return (
        <div className="space-y-4">
            {turns.map((turn, index) => {
                const position = order.indexOf(turn.speaker);
                const style =
                    SPEAKER_STYLES[
                        (position === -1 ? 0 : position) % SPEAKER_STYLES.length
                    ];
                return (
                    <div
                        key={`${turn.speaker}-${index}-${turn.text.slice(0, 24)}`}
                        className="space-y-1"
                    >
                        {turn.label && (
                            <div className="relative flex items-center gap-2">
                                <span
                                    className={`size-1.5 rounded-full shrink-0 ${style.dot}`}
                                />
                                {attributable ? (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setOpenLabel((open) =>
                                                open === turn.speaker
                                                    ? null
                                                    : turn.speaker,
                                            )
                                        }
                                        className={`rounded text-xs font-medium underline-offset-4 hover:underline ${style.text}`}
                                        title={
                                            names[turn.speaker]
                                                ? "Change who this is"
                                                : "Name this speaker"
                                        }
                                    >
                                        {names[turn.speaker] ?? turn.label}
                                    </button>
                                ) : (
                                    <span
                                        className={`text-xs font-medium ${style.text}`}
                                    >
                                        {names[turn.speaker] ?? turn.label}
                                    </span>
                                )}
                                {openLabel === turn.speaker && (
                                    <SpeakerPicker
                                        label={turn.label}
                                        personId={
                                            names[turn.speaker] ? "set" : null
                                        }
                                        onPick={(choice) =>
                                            void attribute(turn.speaker, choice)
                                        }
                                        onClear={() =>
                                            void attribute(turn.speaker, null)
                                        }
                                        onClose={() => setOpenLabel(null)}
                                    />
                                )}
                            </div>
                        )}
                        <p className="text-sm whitespace-pre-wrap leading-relaxed pl-3.5">
                            {turn.text}
                        </p>
                    </div>
                );
            })}
        </div>
    );
}
