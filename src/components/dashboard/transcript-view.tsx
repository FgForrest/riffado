"use client";

import { useMemo } from "react";
import {
    mayBeDiarized,
    parseSpeakerTurns,
    speakerOrder,
} from "@/lib/transcription/diarization";

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
export function TranscriptView({ text, source, model }: TranscriptViewProps) {
    const turns = useMemo(() => {
        if (!mayBeDiarized({ source, model })) return null;
        return parseSpeakerTurns(text);
    }, [text, source, model]);

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
                            <div className="flex items-center gap-2">
                                <span
                                    className={`size-1.5 rounded-full shrink-0 ${style.dot}`}
                                />
                                <span
                                    className={`text-xs font-medium ${style.text}`}
                                >
                                    {turn.label}
                                </span>
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
