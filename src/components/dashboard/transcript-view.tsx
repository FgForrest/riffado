"use client";

import { useExtracted } from "next-intl";
import { Fragment, useMemo } from "react";
import type { SpeakerAttributions } from "@/lib/knowledge/speaker-references";
import {
    containingTurnIndex,
    formatClock,
    type TranscriptTopic,
} from "@/lib/topics/timeline";
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
    /** Confirmed names projected over raw labels without changing the text. */
    speakerAttributions?: SpeakerAttributions;
    /** Seek audio to a timed turn. Omitted when audio is unavailable. */
    onSeekToTurn?: (startMs: number) => void;
    /**
     * Topics of this transcript. Each is shown as a heading above the stored
     * turn its start falls in; they need `storedTurns` to be placed.
     */
    topics?: TranscriptTopic[] | null;
    /** Topic to highlight briefly, after a jump to it. */
    highlightedTopic?: number | null;
}

interface RenderableTurn {
    speaker: string;
    label: string;
    text: string;
    startMs?: number;
}

function formatTimestamp(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
        ? [hours, minutes, seconds]
              .map((value) => String(value).padStart(2, "0"))
              .join(":")
        : [minutes, seconds]
              .map((value) => String(value).padStart(2, "0"))
              .join(":");
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
    speakerAttributions = {},
    onSeekToTurn,
    topics,
    highlightedTopic = null,
}: TranscriptViewProps) {
    const i18n = useExtracted();
    const turns = useMemo<RenderableTurn[] | null>(() => {
        if (storedTurns?.length) {
            return storedTurns.map((turn) => ({
                speaker: turn.speaker,
                label: formatSpeakerLabel(turn.speaker),
                text: turn.text,
                startMs: turn.startMs,
            }));
        }
        if (!mayBeDiarized({ source, model })) return null;
        return parseSpeakerTurns(text);
    }, [text, source, model, storedTurns]);
    // Topic indices by the turn they start in. Only stored turns carry the
    // timings topics are anchored to, so a transcript without them shows none.
    const topicsByTurn = useMemo(() => {
        const byTurn = new Map<number, number[]>();
        if (!topics?.length || !storedTurns?.length) return byTurn;
        topics.forEach((topic, topicIndex) => {
            const turnIndex = containingTurnIndex(storedTurns, topic.fromMs);
            byTurn.set(turnIndex, [
                ...(byTurn.get(turnIndex) ?? []),
                topicIndex,
            ]);
        });
        return byTurn;
    }, [topics, storedTurns]);
    const highlightedTurn =
        highlightedTopic !== null &&
        topics?.[highlightedTopic] &&
        storedTurns?.length
            ? containingTurnIndex(storedTurns, topics[highlightedTopic].fromMs)
            : null;

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
                const displayName =
                    speakerAttributions[turn.speaker]?.name ?? turn.label;
                const canSeek =
                    onSeekToTurn !== undefined &&
                    turn.startMs !== undefined &&
                    Number.isFinite(turn.startMs);
                return (
                    <Fragment
                        key={`${turn.speaker}-${index}-${turn.text.slice(0, 24)}`}
                    >
                        {topicsByTurn.get(index)?.map((topicIndex) => {
                            const topic = (topics as TranscriptTopic[])[
                                topicIndex
                            ];
                            // The same form as the topics list, so both read alike.
                            const time = formatClock(topic.fromMs);
                            return (
                                <div
                                    key={`topic-${topicIndex}-${topic.fromMs}`}
                                    data-topic-index={topicIndex}
                                    className={`flex scroll-mt-2 items-baseline gap-2 rounded-md border-t border-border/60 px-1 pt-3 transition-colors duration-700 ${topicIndex === 0 && index === 0 ? "border-t-0 pt-0" : ""} ${highlightedTopic === topicIndex ? "bg-primary/10" : ""}`}
                                >
                                    <span className="text-sm font-semibold tabular-nums text-primary">
                                        {topicIndex + 1}.
                                    </span>
                                    <h4 className="min-w-0 flex-1 text-sm font-semibold">
                                        {topic.title}
                                    </h4>
                                    {onSeekToTurn ? (
                                        <button
                                            type="button"
                                            className="shrink-0 rounded-sm font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            onClick={() =>
                                                onSeekToTurn(topic.fromMs)
                                            }
                                            aria-label={i18n(
                                                "Jump to topic {title} at {time}",
                                                { title: topic.title, time },
                                            )}
                                        >
                                            {time}
                                        </button>
                                    ) : (
                                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                            {time}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                        <div
                            data-turn-index={index}
                            className={`space-y-1 rounded-md transition-colors duration-700 ${highlightedTurn === index ? "bg-primary/10" : ""}`}
                        >
                            {!turn.label && canSeek && (
                                <button
                                    type="button"
                                    className="rounded-sm font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    onClick={() =>
                                        onSeekToTurn(turn.startMs ?? 0)
                                    }
                                    aria-label={i18n("Seek audio to {time}", {
                                        time: formatTimestamp(
                                            turn.startMs ?? 0,
                                        ),
                                    })}
                                >
                                    {formatTimestamp(turn.startMs ?? 0)}
                                </button>
                            )}
                            {turn.label && (
                                <div className="relative flex items-center gap-2">
                                    <span
                                        className={`size-1.5 rounded-full shrink-0 ${style.dot}`}
                                    />
                                    {canSeek ? (
                                        <button
                                            type="button"
                                            className={`rounded-sm text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${style.text}`}
                                            onClick={() =>
                                                onSeekToTurn(turn.startMs ?? 0)
                                            }
                                            aria-label={i18n(
                                                "Seek audio to {time}, {speaker}",
                                                {
                                                    time: formatTimestamp(
                                                        turn.startMs ?? 0,
                                                    ),
                                                    speaker: displayName,
                                                },
                                            )}
                                            title={i18n(
                                                "Seek audio to {time}",
                                                {
                                                    time: formatTimestamp(
                                                        turn.startMs ?? 0,
                                                    ),
                                                },
                                            )}
                                        >
                                            {displayName}
                                        </button>
                                    ) : (
                                        <span
                                            className={`text-xs font-medium ${style.text}`}
                                        >
                                            {displayName}
                                        </span>
                                    )}
                                </div>
                            )}
                            <p
                                className={`text-sm whitespace-pre-wrap leading-relaxed ${turn.label ? "pl-3.5" : ""}`}
                            >
                                {turn.text}
                            </p>
                        </div>
                    </Fragment>
                );
            })}
        </div>
    );
}
