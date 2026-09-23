"use client";

import {
    ChevronDown,
    ChevronUp,
    FileText,
    Languages,
    ListChecks,
    Loader2,
    RefreshCw,
    Sparkles,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MarkdownActions } from "@/components/dashboard/markdown-actions";
import { TranscribeInBrowserButton } from "@/components/dashboard/transcribe-in-browser-button";
import { TranscriptView } from "@/components/dashboard/transcript-view";
import { Markdown } from "@/components/markdown";
import {
    confirmedAttributions,
    type SpeakerResponseRow,
    SpeakerTags,
    type TranscriptSpeakerTag,
} from "@/components/people/speaker-tags";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    type SummarySource,
    useTranscriptionSummary,
} from "@/hooks/use-transcription-summary";
import {
    inferSummarySpeakerNumberOffset,
    type SpeakerAttributions,
} from "@/lib/knowledge/speaker-references";
import { withRecordingView } from "@/lib/sharing/view";
import { describeMultiPass } from "@/lib/summary/multi-pass";
import { formatElapsed } from "@/lib/summary/progress-stream";
import {
    formatSpeakerLabel,
    mayBeDiarized,
    parseSpeakerTurns,
    speakerOrder,
} from "@/lib/transcription/diarization";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import type { Recording } from "@/types/recording";

export interface Transcription {
    text?: string;
    language?: string;
    source?: string;
    provider?: string;
    model?: string;
    /** Provider-reported turns, when the transcript was stored with them. */
    turns?: TranscriptTurn[] | null;
}

/** A transcript variant for a single source (Plaud, the user's own, etc.). */
export interface TranscriptOption {
    source: string;
    text: string;
    language?: string;
    provider?: string;
    model?: string;
    /** Provider-reported turns, when the transcript was stored with them. */
    turns?: TranscriptTurn[] | null;
}

interface TranscriptionPanelProps {
    recording: Recording;
    /** Back-compat single transcript. Used only when `transcripts` is absent. */
    transcription?: Transcription;
    /** All transcripts for the recording, one per source, primary first. When
     * more than one is present a source switcher is shown. */
    transcripts?: TranscriptOption[];
    isTranscribing: boolean;
    onTranscribe: (attributionSource?: string) => void;
    /** Refresh handler called after a browser-side transcription completes. */
    onTranscribeComplete?: () => void;
    /** Seek the recording audio to a provider-reported transcript turn. */
    onSeekToTurn?: (startMs: number) => void;
}

function SourceSwitcher({
    ariaLabel,
    sources,
    value,
    onSelect,
}: {
    ariaLabel: string;
    sources: readonly string[];
    value: string;
    onSelect: (source: string) => void;
}) {
    const i18n = useExtracted();
    return (
        <fieldset
            className="inline-flex shrink-0 rounded-lg bg-muted/70 p-1"
            aria-label={ariaLabel}
        >
            {sources.map((source) => (
                <button
                    key={source}
                    type="button"
                    onClick={() => onSelect(source)}
                    aria-pressed={source === value}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                        source === value
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
                    }`}
                >
                    {source === "plaud"
                        ? "Plaud"
                        : source === "mixed"
                          ? i18n("Mix")
                          : i18n("Custom")}
                </button>
            ))}
        </fieldset>
    );
}

/**
 * Normalise the two transcript-shaped props into one list.
 *
 * `source` and `model` must survive the single-transcript path: they are what
 * `TranscriptView` reads to decide whether the text was diarized, so
 * defaulting them here instead of carrying them through silently downgrades a
 * dialog to plain text.
 */
export function toTranscriptList(
    transcripts: TranscriptOption[] | undefined,
    transcription: Transcription | undefined,
): TranscriptOption[] {
    if (transcripts && transcripts.length > 0) return transcripts;
    if (!transcription?.text) return [];
    return [
        {
            source: transcription.source ?? "riffado",
            text: transcription.text,
            language: transcription.language,
            provider: transcription.provider,
            model: transcription.model,
            turns: transcription.turns,
        },
    ];
}

/** Distinct speaker tags in first-appearance order for one transcript. */
export function transcriptSpeakerTags(
    transcript: TranscriptOption | undefined,
): TranscriptSpeakerTag[] {
    if (!transcript) return [];
    const turns = transcript.turns?.length
        ? transcript.turns.map((turn) => ({
              speaker: turn.speaker,
              label: formatSpeakerLabel(turn.speaker),
              text: turn.text,
          }))
        : mayBeDiarized(transcript)
          ? parseSpeakerTurns(transcript.text)
          : null;
    if (!turns) return [];
    return speakerOrder(turns).map((speaker) => ({
        speaker,
        label: formatSpeakerLabel(speaker),
    }));
}

export function TranscriptionPanel({
    recording,
    transcription,
    transcripts,
    isTranscribing,
    onTranscribe,
    onTranscribeComplete,
    onSeekToTurn,
}: TranscriptionPanelProps) {
    const i18n = useExtracted();
    const transcriptList = toTranscriptList(transcripts, transcription);
    // The Organization view of a shared recording: its own transcript and
    // summary, made with the organization's templates, never the owner's.
    const view = recording.view;
    const orgView = view === "org";

    const [activeSource, setActiveSource] = useState<string | undefined>(
        undefined,
    );
    const [transcriptExpanded, setTranscriptExpanded] = useState(true);
    const activeTranscript =
        transcriptList.find((t) => t.source === activeSource) ??
        transcriptList[0];
    const canHavePlaudSummary =
        !orgView &&
        (recording.deviceSn !== "local" ||
            transcriptList.some((candidate) => candidate.source === "plaud"));
    const speakerTags = useMemo(
        () => transcriptSpeakerTags(activeTranscript),
        [activeTranscript],
    );
    const attributionKey = activeTranscript
        ? `${recording.id}:${activeTranscript.source}`
        : "";
    const [attributionsByKey, setAttributionsByKey] = useState<
        Record<string, SpeakerAttributions>
    >({});
    const speakerAttributions = attributionsByKey[attributionKey] ?? {};
    const handleAttributionsChange = useCallback(
        (values: SpeakerAttributions) => {
            setAttributionsByKey((current) => ({
                ...current,
                [attributionKey]: values,
            }));
        },
        [attributionKey],
    );

    const defaultSummarySource: SummarySource =
        activeTranscript?.source === "plaud" ? "plaud" : "riffado";
    const [summarySelection, setSummarySelection] = useState<{
        recordingId: string;
        source: SummarySource;
    }>({ recordingId: "", source: "riffado" });
    const summarySource =
        summarySelection.recordingId === recording.id
            ? summarySelection.source
            : defaultSummarySource;
    const summaryTranscript = transcriptList.find(
        (candidate) => candidate.source === summarySource,
    );
    const summarySpeakerTags = useMemo(
        () => transcriptSpeakerTags(summaryTranscript),
        [summaryTranscript],
    );
    const summaryAttributionKey = summaryTranscript
        ? `${recording.id}:${summaryTranscript.source}`
        : "";
    const summarySpeakerAttributions =
        attributionsByKey[summaryAttributionKey] ?? {};

    useEffect(() => {
        if (!summaryTranscript || summaryAttributionKey === attributionKey) {
            return;
        }
        const controller = new AbortController();
        void fetch(
            withRecordingView(
                `/api/recordings/${recording.id}/speakers?source=${encodeURIComponent(summaryTranscript.source)}`,
                view,
            ),
            { signal: controller.signal },
        )
            .then(async (response) => {
                if (!response.ok) return null;
                return (await response.json()) as {
                    speakers?: SpeakerResponseRow[];
                };
            })
            .then((body) => {
                if (!body) return;
                setAttributionsByKey((current) => ({
                    ...current,
                    [summaryAttributionKey]: confirmedAttributions(
                        body.speakers,
                    ),
                }));
            })
            .catch(() => {});
        return () => controller.abort();
    }, [
        attributionKey,
        recording.id,
        summaryAttributionKey,
        summaryTranscript,
        view,
    ]);

    const {
        summaryData,
        isSummarizing,
        summaryProgress,
        summaryElapsedMs,
        summaryExpanded,
        setSummaryExpanded,
        summaryPreset,
        setSummaryPreset,
        summaryPromptOptions,
        handleSummarize,
    } = useTranscriptionSummary({
        recordingId: recording?.id,
        summarySource,
        transcriptionText: summaryTranscript?.text,
        view,
    });

    // Null for a single-pass summary, so the badge simply does not
    // render. Derived rather than stored on the client: the shape comes
    // from POST and GET alike, so a reload shows the same badge.
    const baseMultiPassBadge = describeMultiPass(summaryData?.multiPass);
    const multiPassBadge = (() => {
        const provenance = summaryData?.multiPass;
        if (!baseMultiPassBadge || !provenance) return null;
        const { roundsRequested, passesUsed, merged } = provenance;
        let title: string;
        if (merged && passesUsed === roundsRequested) {
            title = i18n("{used} of {requested} passes merged", {
                used: String(passesUsed),
                requested: String(roundsRequested),
            });
        } else if (passesUsed === 0) {
            title = i18n(
                "No pass returned usable output; showing the raw reply of {requested}.",
                { requested: String(roundsRequested) },
            );
        } else if (!merged && passesUsed === 1) {
            title = i18n(
                "Only 1 of {requested} passes succeeded, so it is shown unmerged.",
                { requested: String(roundsRequested) },
            );
        } else if (!merged) {
            title = i18n(
                "{used} of {requested} passes succeeded, but the merge failed; showing the most complete single pass.",
                {
                    used: String(passesUsed),
                    requested: String(roundsRequested),
                },
            );
        } else {
            title = i18n(
                "{used} of {requested} passes succeeded and were merged.",
                {
                    used: String(passesUsed),
                    requested: String(roundsRequested),
                },
            );
        }
        return {
            ...baseMultiPassBadge,
            label: i18n("multi-pass · {passes}", {
                passes:
                    passesUsed === roundsRequested
                        ? String(roundsRequested)
                        : `${passesUsed}/${roundsRequested}`,
            }),
            title,
        };
    })();
    const summaryStatusLabel = !summaryProgress
        ? i18n("Generating summary…")
        : summaryProgress.phase === "merging"
          ? i18n("Merging {count, plural, one {# pass} other {# passes}}…", {
                count: summaryProgress.total,
            })
          : i18n("Summarizing — {completed}/{total} passes", {
                completed: String(summaryProgress.completed),
                total: String(summaryProgress.total),
            });
    const summaryStatus =
        summaryElapsedMs > 0
            ? `${summaryStatusLabel} · ${formatElapsed(summaryElapsedMs)}`
            : summaryStatusLabel;
    const summarySpeakerNumberOffset = useMemo(() => {
        if (!summaryData) return 0;
        return inferSummarySpeakerNumberOffset(
            [
                summaryData.summary,
                ...(summaryData.keyPoints ?? []),
                ...(summaryData.actionItems ?? []),
            ].join("\n"),
            summarySpeakerTags.map((speaker) => speaker.speaker),
        );
    }, [summaryData, summarySpeakerTags]);

    return (
        <div className="space-y-4">
            {/* Transcription Card */}
            <Card>
                <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
                        <CardTitle className="flex items-center gap-2">
                            <FileText className="size-5" />{" "}
                            {i18n("Transcription")}
                        </CardTitle>
                        <div className="flex flex-wrap items-center gap-2">
                            {transcriptList.length > 1 && activeTranscript && (
                                <SourceSwitcher
                                    ariaLabel={i18n("Transcript source")}
                                    sources={transcriptList.map(
                                        (candidate) => candidate.source,
                                    )}
                                    value={activeTranscript.source}
                                    onSelect={setActiveSource}
                                />
                            )}
                            {activeTranscript?.text && (
                                <MarkdownActions
                                    recordingId={recording.id}
                                    kind="transcript"
                                    source={activeTranscript.source}
                                    view={view}
                                />
                            )}
                            {activeTranscript?.text && (
                                <Button
                                    onClick={() =>
                                        onTranscribe(activeTranscript.source)
                                    }
                                    size="sm"
                                    variant="outline"
                                    // No audio, nothing to re-transcribe
                                    // from. Both the server route and the
                                    // browser one would only fetch a 410.
                                    disabled={
                                        isTranscribing || recording.audioReaped
                                    }
                                    title={
                                        recording.audioReaped
                                            ? i18n(
                                                  "Audio was removed by your retention policy",
                                              )
                                            : undefined
                                    }
                                >
                                    <RefreshCw className="size-4 mr-2" />{" "}
                                    {i18n("Re-transcribe")}
                                </Button>
                            )}
                            {!activeTranscript?.text && !isTranscribing && (
                                <>
                                    <Button
                                        onClick={() => onTranscribe()}
                                        size="sm"
                                        disabled={
                                            isTranscribing ||
                                            recording.audioReaped
                                        }
                                        title={
                                            recording.audioReaped
                                                ? i18n(
                                                      "Audio was removed by your retention policy",
                                                  )
                                                : undefined
                                        }
                                    >
                                        <Sparkles className="size-4 mr-2" />{" "}
                                        {i18n("Transcribe")}
                                    </Button>
                                    {!orgView && (
                                        <TranscribeInBrowserButton
                                            recordingId={recording.id}
                                            disabled={
                                                isTranscribing ||
                                                recording.audioReaped
                                            }
                                            onComplete={
                                                // Falling back to `onTranscribe` here
                                                // would kick off a redundant SERVER
                                                // transcription right after a
                                                // successful browser one, possibly
                                                // overwriting it. Callers that care
                                                // about refreshing after a browser
                                                // transcription must pass
                                                // `onTranscribeComplete` explicitly.
                                                onTranscribeComplete ??
                                                (() => {})
                                            }
                                        />
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                    {activeTranscript && speakerTags.length > 0 && (
                        <SpeakerTags
                            recordingId={recording.id}
                            source={activeTranscript.source}
                            speakers={speakerTags}
                            attributions={speakerAttributions}
                            onAttributionsChange={handleAttributionsChange}
                            view={view}
                        />
                    )}
                </CardHeader>
                <CardContent>
                    {isTranscribing ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <div className="animate-spin size-8 border-2 border-primary border-t-transparent rounded-full mb-4" />
                            <p className="text-sm text-muted-foreground">
                                {i18n("Transcribing audio…")}
                            </p>
                        </div>
                    ) : activeTranscript?.text ? (
                        <div className="space-y-4">
                            <button
                                type="button"
                                aria-expanded={transcriptExpanded}
                                onClick={() =>
                                    setTranscriptExpanded(!transcriptExpanded)
                                }
                                className="flex items-center gap-1 text-sm font-medium transition-colors hover:text-primary"
                            >
                                {transcriptExpanded ? (
                                    <ChevronUp className="size-4" />
                                ) : (
                                    <ChevronDown className="size-4" />
                                )}
                                {transcriptExpanded
                                    ? i18n("Collapse transcript")
                                    : i18n("Expand transcript")}
                            </button>
                            {transcriptExpanded && (
                                <div className="space-y-4">
                                    <section
                                        aria-label={i18n("Transcript content")}
                                        className="max-h-96 overflow-y-auto rounded-lg bg-muted p-4"
                                    >
                                        <TranscriptView
                                            text={activeTranscript.text}
                                            source={activeTranscript.source}
                                            model={activeTranscript.model}
                                            storedTurns={activeTranscript.turns}
                                            speakerAttributions={
                                                speakerAttributions
                                            }
                                            onSeekToTurn={onSeekToTurn}
                                        />
                                    </section>
                                    <div className="flex items-center gap-4 border-t pt-2 text-xs text-muted-foreground">
                                        <span className="rounded bg-muted px-2 py-0.5 font-medium">
                                            {activeTranscript.source === "plaud"
                                                ? "Plaud"
                                                : activeTranscript.source ===
                                                    "mixed"
                                                  ? i18n("Mix")
                                                  : i18n("Custom")}
                                        </span>
                                        {activeTranscript.provider && (
                                            <span className="rounded bg-muted px-2 py-0.5">
                                                {activeTranscript.provider}
                                            </span>
                                        )}
                                        {activeTranscript.model && (
                                            <span className="rounded bg-muted px-2 py-0.5 font-mono">
                                                {activeTranscript.model}
                                            </span>
                                        )}
                                        {activeTranscript.language && (
                                            <div className="flex items-center gap-1">
                                                <Languages className="size-3" />
                                                <span>
                                                    {i18n("Language:")}{" "}
                                                    {activeTranscript.language}
                                                </span>
                                            </div>
                                        )}
                                        <div>
                                            {activeTranscript.text.trim()
                                                ? activeTranscript.text
                                                      .trim()
                                                      .split(/\s+/).length
                                                : 0}{" "}
                                            {i18n("words")}
                                        </div>
                                        <div>
                                            {activeTranscript.text.length}{" "}
                                            {i18n("characters")}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-10 text-center">
                            <FileText className="size-10 text-muted-foreground mb-3" />
                            <p className="text-sm text-muted-foreground">
                                {i18n(
                                    "No transcription yet. Use the Transcribe button above.",
                                )}
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Summary Card -- only show when a transcript exists */}
            {activeTranscript?.text && (
                <Card>
                    <CardHeader>
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
                            <CardTitle className="flex items-center gap-2">
                                <ListChecks className="size-5" />{" "}
                                {i18n("Summary")}
                            </CardTitle>
                            <div className="flex flex-wrap items-center gap-2">
                                {canHavePlaudSummary && (
                                    <SourceSwitcher
                                        ariaLabel={i18n("Summary source")}
                                        sources={["plaud", "riffado"]}
                                        value={summarySource}
                                        onSelect={(source) =>
                                            setSummarySelection({
                                                recordingId: recording.id,
                                                source:
                                                    source === "plaud"
                                                        ? "plaud"
                                                        : "riffado",
                                            })
                                        }
                                    />
                                )}
                                {summaryData?.summary && (
                                    <MarkdownActions
                                        recordingId={recording.id}
                                        kind="summary"
                                        source={summarySource}
                                        view={view}
                                    />
                                )}
                                {summarySource === "riffado" &&
                                    !orgView &&
                                    !isSummarizing && (
                                        <Select
                                            value={summaryPreset}
                                            onValueChange={setSummaryPreset}
                                        >
                                            <SelectTrigger className="w-[160px] h-8 text-xs">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {summaryPromptOptions.map(
                                                    (preset) => (
                                                        <SelectItem
                                                            key={preset.id}
                                                            value={preset.id}
                                                        >
                                                            {preset.name}
                                                        </SelectItem>
                                                    ),
                                                )}
                                            </SelectContent>
                                        </Select>
                                    )}
                                {summarySource === "riffado" && (
                                    <Button
                                        onClick={handleSummarize}
                                        size="sm"
                                        variant={
                                            summaryData ? "outline" : "default"
                                        }
                                        disabled={
                                            isSummarizing ||
                                            (!summaryTranscript &&
                                                !(
                                                    orgView &&
                                                    transcriptList.length > 0
                                                ))
                                        }
                                    >
                                        {isSummarizing ? (
                                            <>
                                                <Loader2 className="size-4 mr-2 animate-spin" />{" "}
                                                {i18n("Generating…")}
                                            </>
                                        ) : summaryData ? (
                                            <>
                                                <RefreshCw className="size-4 mr-2" />{" "}
                                                {i18n("Re-summarize")}
                                            </>
                                        ) : (
                                            <>
                                                <Sparkles className="size-4 mr-2" />{" "}
                                                {i18n("Summarize")}
                                            </>
                                        )}
                                    </Button>
                                )}
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {isSummarizing ? (
                            <div className="flex flex-col items-center justify-center py-8">
                                <Loader2 className="size-8 animate-spin text-primary mb-4" />
                                <p className="text-sm text-muted-foreground">
                                    {summaryStatus}
                                </p>
                            </div>
                        ) : summaryData?.summary ? (
                            <div className="space-y-4">
                                <button
                                    type="button"
                                    aria-expanded={summaryExpanded}
                                    onClick={() =>
                                        setSummaryExpanded(!summaryExpanded)
                                    }
                                    className="flex items-center gap-1 text-sm font-medium hover:text-primary transition-colors"
                                >
                                    {summaryExpanded ? (
                                        <ChevronUp className="size-4" />
                                    ) : (
                                        <ChevronDown className="size-4" />
                                    )}
                                    {summaryExpanded
                                        ? i18n("Collapse summary")
                                        : i18n("Expand summary")}
                                </button>

                                {summaryData.fallback && (
                                    <p className="text-xs text-muted-foreground">
                                        {i18n(
                                            "Showing the owner's summary. Re-summarize to create the Organization version.",
                                        )}
                                    </p>
                                )}
                                {summaryExpanded && (
                                    <section
                                        aria-label={i18n("Summary content")}
                                        className="max-h-96 space-y-4 overflow-y-auto pr-2"
                                    >
                                        {/* Summary text */}
                                        <div className="bg-muted rounded-lg p-4 text-sm">
                                            <Markdown
                                                speakerAttributions={
                                                    summarySpeakerAttributions
                                                }
                                                speakerNumberOffset={
                                                    summarySpeakerNumberOffset
                                                }
                                            >
                                                {summaryData.summary}
                                            </Markdown>
                                        </div>

                                        {/* Key points */}
                                        {summaryData.keyPoints &&
                                            summaryData.keyPoints.length >
                                                0 && (
                                                <div>
                                                    <h4 className="text-sm font-medium mb-2">
                                                        {i18n("Key Points")}
                                                    </h4>
                                                    <ul className="space-y-1">
                                                        {summaryData.keyPoints.map(
                                                            (point) => {
                                                                const key = `kp-${point.slice(0, 32)}`;
                                                                return (
                                                                    <li
                                                                        key={
                                                                            key
                                                                        }
                                                                        className="text-sm text-muted-foreground flex items-start gap-2"
                                                                    >
                                                                        <span className="text-primary mt-1.5 size-1.5 rounded-full bg-primary shrink-0" />
                                                                        <Markdown
                                                                            inline
                                                                            speakerAttributions={
                                                                                summarySpeakerAttributions
                                                                            }
                                                                            speakerNumberOffset={
                                                                                summarySpeakerNumberOffset
                                                                            }
                                                                        >
                                                                            {
                                                                                point
                                                                            }
                                                                        </Markdown>
                                                                    </li>
                                                                );
                                                            },
                                                        )}
                                                    </ul>
                                                </div>
                                            )}

                                        {/* Action items */}
                                        {summaryData.actionItems &&
                                            summaryData.actionItems.length >
                                                0 && (
                                                <div>
                                                    <h4 className="text-sm font-medium mb-2">
                                                        {i18n("Action Items")}
                                                    </h4>
                                                    <ul className="space-y-1">
                                                        {summaryData.actionItems.map(
                                                            (item) => {
                                                                const key = `ai-${item.slice(0, 32)}`;
                                                                return (
                                                                    <li
                                                                        key={
                                                                            key
                                                                        }
                                                                        className="text-sm text-muted-foreground flex items-start gap-2"
                                                                    >
                                                                        <ListChecks className="size-3.5 mt-0.5 text-primary shrink-0" />
                                                                        <Markdown
                                                                            inline
                                                                            speakerAttributions={
                                                                                summarySpeakerAttributions
                                                                            }
                                                                            speakerNumberOffset={
                                                                                summarySpeakerNumberOffset
                                                                            }
                                                                        >
                                                                            {
                                                                                item
                                                                            }
                                                                        </Markdown>
                                                                    </li>
                                                                );
                                                            },
                                                        )}
                                                    </ul>
                                                </div>
                                            )}

                                        {/* Summary metadata */}
                                        <div className="flex items-center border-t pt-2">
                                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                                <span className="px-2 py-0.5 rounded bg-muted font-medium">
                                                    {summarySource === "plaud"
                                                        ? "Plaud"
                                                        : i18n("Custom")}
                                                </span>
                                                {summaryData.provider && (
                                                    <span className="px-2 py-0.5 rounded bg-muted">
                                                        {summaryData.provider}
                                                    </span>
                                                )}
                                                {summaryData.model && (
                                                    <span className="px-2 py-0.5 rounded bg-muted font-mono">
                                                        {summaryData.model}
                                                    </span>
                                                )}
                                                {multiPassBadge && (
                                                    <span
                                                        className={
                                                            multiPassBadge.degraded
                                                                ? "px-2 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                                                : "px-2 py-0.5 rounded bg-muted"
                                                        }
                                                        title={
                                                            multiPassBadge.title
                                                        }
                                                    >
                                                        {multiPassBadge.label}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </section>
                                )}
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-8 text-center">
                                <ListChecks className="size-10 text-muted-foreground mb-3" />
                                <p className="text-sm text-muted-foreground">
                                    {summarySource === "plaud"
                                        ? i18n(
                                              "No Plaud summary has been imported. It will appear after Plaud sync when available.",
                                          )
                                        : summaryTranscript
                                          ? i18n(
                                                'No custom summary yet. Click "Summarize" to generate one.',
                                            )
                                          : i18n(
                                                "A custom transcript is required before generating a custom summary.",
                                            )}
                                </p>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
