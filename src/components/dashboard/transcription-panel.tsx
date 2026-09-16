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
    Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { MarkdownActions } from "@/components/dashboard/markdown-actions";
import { TranscribeInBrowserButton } from "@/components/dashboard/transcribe-in-browser-button";
import { TranscriptView } from "@/components/dashboard/transcript-view";
import { Markdown } from "@/components/markdown";
import {
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
import { useTranscriptionSummary } from "@/hooks/use-transcription-summary";
import type { SpeakerAttributions } from "@/lib/knowledge/speaker-references";
import { describeMultiPass } from "@/lib/summary/multi-pass";
import { formatSummaryStatus } from "@/lib/summary/progress-stream";
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
    onTranscribe: () => void;
    /** Refresh handler called after a browser-side transcription completes. */
    onTranscribeComplete?: () => void;
    /** Seek the recording audio to a provider-reported transcript turn. */
    onSeekToTurn?: (startMs: number) => void;
}

function transcriptSourceLabel(source: string): string {
    if (source === "plaud") return "Plaud";
    if (source === "mixed") return "Mix";
    return "Your provider";
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
    const transcriptList = toTranscriptList(transcripts, transcription);

    const [activeSource, setActiveSource] = useState<string | undefined>(
        undefined,
    );
    const [transcriptExpanded, setTranscriptExpanded] = useState(true);
    const activeTranscript =
        transcriptList.find((t) => t.source === activeSource) ??
        transcriptList[0];
    const speakerTags = useMemo(
        () => transcriptSpeakerTags(activeTranscript),
        [activeTranscript],
    );
    const attributionKey = activeTranscript
        ? `${recording.id}:${activeTranscript.source}`
        : "";
    const [attributionState, setAttributionState] = useState<{
        key: string;
        values: SpeakerAttributions;
    }>({ key: "", values: {} });
    const speakerAttributions =
        attributionState.key === attributionKey ? attributionState.values : {};
    const handleAttributionsChange = useCallback(
        (values: SpeakerAttributions) => {
            setAttributionState({ key: attributionKey, values });
        },
        [attributionKey],
    );

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
        handleDeleteSummary,
    } = useTranscriptionSummary({
        recordingId: recording?.id,
        transcriptionText: activeTranscript?.text,
    });

    // Null for a single-pass summary, so the badge simply does not
    // render. Derived rather than stored on the client: the shape comes
    // from POST and GET alike, so a reload shows the same badge.
    const multiPassBadge = describeMultiPass(summaryData?.multiPass);

    return (
        <div className="space-y-4">
            {/* Transcription Card */}
            <Card>
                <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <CardTitle className="flex items-center gap-2">
                            <FileText className="size-5" />
                            Transcription
                        </CardTitle>
                        <div className="flex flex-wrap items-center gap-2">
                            {activeTranscript?.text && (
                                <MarkdownActions
                                    recordingId={recording.id}
                                    kind="transcript"
                                />
                            )}
                            {activeTranscript?.text && (
                                <Button
                                    onClick={onTranscribe}
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
                                            ? "Audio was removed by your retention policy"
                                            : undefined
                                    }
                                >
                                    <RefreshCw className="size-4 mr-2" />
                                    Re-transcribe
                                </Button>
                            )}
                            {!activeTranscript?.text && !isTranscribing && (
                                <>
                                    <Button
                                        onClick={onTranscribe}
                                        size="sm"
                                        disabled={
                                            isTranscribing ||
                                            recording.audioReaped
                                        }
                                        title={
                                            recording.audioReaped
                                                ? "Audio was removed by your retention policy"
                                                : undefined
                                        }
                                    >
                                        <Sparkles className="size-4 mr-2" />
                                        Transcribe
                                    </Button>
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
                                            onTranscribeComplete ?? (() => {})
                                        }
                                    />
                                </>
                            )}
                        </div>
                    </div>
                    {activeTranscript && speakerTags.length > 0 && (
                        <SpeakerTags
                            recordingId={recording.id}
                            source={activeTranscript.source}
                            speakers={speakerTags}
                            onAttributionsChange={handleAttributionsChange}
                        />
                    )}
                </CardHeader>
                <CardContent>
                    {isTranscribing ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <div className="animate-spin size-8 border-2 border-primary border-t-transparent rounded-full mb-4" />
                            <p className="text-sm text-muted-foreground">
                                Transcribing audio…
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
                                    ? "Collapse transcript"
                                    : "Expand transcript"}
                            </button>
                            {transcriptExpanded && (
                                <div className="space-y-4">
                                    {transcriptList.length > 1 && (
                                        <div className="flex items-center gap-2 border-b pb-2">
                                            {transcriptList.map((t) => (
                                                <button
                                                    key={t.source}
                                                    type="button"
                                                    onClick={() =>
                                                        setActiveSource(
                                                            t.source,
                                                        )
                                                    }
                                                    className={`px-3 py-1 text-xs rounded-md transition-colors ${
                                                        t.source ===
                                                        activeTranscript.source
                                                            ? "bg-primary text-primary-foreground"
                                                            : "bg-muted text-muted-foreground hover:text-foreground"
                                                    }`}
                                                >
                                                    {transcriptSourceLabel(
                                                        t.source,
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    <section
                                        aria-label="Transcript content"
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
                                            {transcriptSourceLabel(
                                                activeTranscript.source,
                                            )}
                                        </span>
                                        {activeTranscript.language && (
                                            <div className="flex items-center gap-1">
                                                <Languages className="size-3" />
                                                <span>
                                                    Language:{" "}
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
                                            words
                                        </div>
                                        <div>
                                            {activeTranscript.text.length}{" "}
                                            characters
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-10 text-center">
                            <FileText className="size-10 text-muted-foreground mb-3" />
                            <p className="text-sm text-muted-foreground">
                                No transcription yet. Use the Transcribe button
                                above.
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Summary Card -- only show when a transcript exists */}
            {activeTranscript?.text && (
                <Card>
                    <CardHeader>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <CardTitle className="flex items-center gap-2">
                                <ListChecks className="size-5" />
                                Summary
                            </CardTitle>
                            <div className="flex flex-wrap items-center gap-2">
                                {summaryData?.summary && (
                                    <MarkdownActions
                                        recordingId={recording.id}
                                        kind="summary"
                                    />
                                )}
                                {!isSummarizing && (
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
                                <Button
                                    onClick={handleSummarize}
                                    size="sm"
                                    variant={
                                        summaryData ? "outline" : "default"
                                    }
                                    disabled={isSummarizing}
                                >
                                    {isSummarizing ? (
                                        <>
                                            <Loader2 className="size-4 mr-2 animate-spin" />
                                            Generating…
                                        </>
                                    ) : summaryData ? (
                                        <>
                                            <RefreshCw className="size-4 mr-2" />
                                            Re-generate
                                        </>
                                    ) : (
                                        <>
                                            <Sparkles className="size-4 mr-2" />
                                            Summarize
                                        </>
                                    )}
                                </Button>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {isSummarizing ? (
                            <div className="flex flex-col items-center justify-center py-8">
                                <Loader2 className="size-8 animate-spin text-primary mb-4" />
                                <p className="text-sm text-muted-foreground">
                                    {formatSummaryStatus(
                                        summaryProgress,
                                        summaryElapsedMs,
                                    )}
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
                                        ? "Collapse summary"
                                        : "Expand summary"}
                                </button>

                                {summaryExpanded && (
                                    <section
                                        aria-label="Summary content"
                                        className="max-h-96 space-y-4 overflow-y-auto pr-2"
                                    >
                                        {/* Summary text */}
                                        <div className="bg-muted rounded-lg p-4 text-sm">
                                            <Markdown
                                                speakerAttributions={
                                                    speakerAttributions
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
                                                        Key Points
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
                                                                                speakerAttributions
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
                                                        Action Items
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
                                                                                speakerAttributions
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

                                        {/* Meta + Delete */}
                                        <div className="flex items-center justify-between pt-2 border-t">
                                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
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
                                            <Button
                                                onClick={handleDeleteSummary}
                                                size="sm"
                                                variant="ghost"
                                                className="text-destructive hover:text-destructive"
                                            >
                                                <Trash2 className="size-4 mr-1" />
                                                Delete
                                            </Button>
                                        </div>
                                    </section>
                                )}
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-8 text-center">
                                <ListChecks className="size-10 text-muted-foreground mb-3" />
                                <p className="text-sm text-muted-foreground">
                                    No summary yet. Click "Summarize" to
                                    generate one.
                                </p>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
