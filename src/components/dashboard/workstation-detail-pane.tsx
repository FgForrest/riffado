"use client";

import { ArrowLeft } from "lucide-react";
import { useRef } from "react";
import {
    RecordingPlayer,
    type RecordingPlayerHandle,
} from "@/components/dashboard/recording-player";
import { RecordingPlayerHeader } from "@/components/dashboard/recording-player-header";
import {
    TranscriptionPanel,
    type TranscriptOption,
} from "@/components/dashboard/transcription-panel";
import { EraseRecordingMenu } from "@/components/recordings/erase-recording-menu";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { cn } from "@/lib/utils";
import type { Recording } from "@/types/recording";

interface TranscriptionData {
    text?: string;
    language?: string;
    source?: string;
    provider?: string;
    model?: string;
    turns?: TranscriptTurn[] | null;
}

interface Props {
    currentRecording: Recording | null;
    currentTranscription: TranscriptionData | undefined;
    transcripts: TranscriptOption[] | undefined;
    isCurrentTranscribing: boolean;
    visibleRecordings: Recording[];
    onTranscribe: (attributionSource?: string) => void;
    /** Called after a browser-side transcription completes (refresh data). */
    onTranscribeComplete?: () => void;
    onSelectRecording: (r: Recording) => void;
    onRenamed?: (filename: string) => void;
    onDelete: (recording: Recording) => Promise<void>;
    onArtifactsChanged: () => void;
    onBackToList: () => void;
    /** When true, the pane is hidden (mobile list view active). */
    hiddenOnMobile: boolean;
    initialPlaybackSpeed: number | undefined;
    initialVolume: number | undefined;
    initialAutoPlayNext: boolean | undefined;
    scrubberStyle: "waveform" | "slider" | undefined;
}

/**
 * Right-hand detail pane: player + transcription. On lg+ this is a column
 * next to the recording list and shares the page scrollbar; on <lg the list
 * and detail toggle via `mobileView` -- both stay mounted so list scroll
 * position / search query / selection survive a back-navigation.
 *
 * Auto-advance on player ended (when `autoPlayNext` is on) moves to
 * the next recording in `visibleRecordings`; the back-affordance is
 * mobile-only because desktop has both panes visible at once.
 */
export function WorkstationDetailPane({
    currentRecording,
    currentTranscription,
    transcripts,
    isCurrentTranscribing,
    visibleRecordings,
    onTranscribe,
    onTranscribeComplete,
    onSelectRecording,
    onRenamed,
    onDelete,
    onArtifactsChanged,
    onBackToList,
    hiddenOnMobile,
    initialPlaybackSpeed,
    initialVolume,
    initialAutoPlayNext,
    scrubberStyle,
}: Props) {
    const playerRef = useRef<RecordingPlayerHandle>(null);
    const hasTranscript =
        currentRecording?.hasTranscript ??
        Boolean(
            currentTranscription?.text ||
                transcripts?.some((transcript) => transcript.text),
        );

    return (
        <div
            className={cn(
                "space-y-6 lg:col-span-2 lg:block lg:self-start",
                hiddenOnMobile && "hidden",
            )}
        >
            {/*
              Mobile back affordance. Returns to the list view without
              dropping the selected recording -- reopening shows the
              same detail. Hidden on lg+ where both panes are visible
              at once.
            */}
            <Button
                variant="ghost"
                size="sm"
                onClick={onBackToList}
                className="-ml-2 h-9 gap-1 px-2 lg:hidden"
            >
                <ArrowLeft className="size-4" />
                Back to recordings
            </Button>
            {currentRecording ? (
                <>
                    <RecordingPlayerHeader
                        recording={currentRecording}
                        onRenamed={onRenamed}
                        action={
                            <EraseRecordingMenu
                                recording={currentRecording}
                                onDeleteLocal={onDelete}
                                onChanged={onArtifactsChanged}
                            />
                        }
                    />
                    {!currentRecording.audioReaped && (
                        <RecordingPlayer
                            ref={playerRef}
                            recording={currentRecording}
                            initialPlaybackSpeed={initialPlaybackSpeed}
                            initialVolume={initialVolume}
                            initialAutoPlayNext={initialAutoPlayNext}
                            scrubberStyle={scrubberStyle}
                            onEnded={() => {
                                const currentIndex =
                                    visibleRecordings.findIndex(
                                        (r) => r.id === currentRecording.id,
                                    );
                                if (
                                    currentIndex >= 0 &&
                                    currentIndex < visibleRecordings.length - 1
                                ) {
                                    onSelectRecording(
                                        visibleRecordings[currentIndex + 1],
                                    );
                                }
                            }}
                        />
                    )}
                    {(!currentRecording.audioReaped || hasTranscript) && (
                        <TranscriptionPanel
                            key={`${currentRecording.id}:${currentRecording.audioReaped ? 1 : 0}:${hasTranscript ? 1 : 0}:${currentRecording.hasSummary ? 1 : 0}`}
                            recording={currentRecording}
                            transcription={currentTranscription}
                            transcripts={transcripts}
                            isTranscribing={isCurrentTranscribing}
                            onTranscribe={onTranscribe}
                            onTranscribeComplete={onTranscribeComplete}
                            onSeekToTurn={
                                currentRecording.audioReaped
                                    ? undefined
                                    : (startMs) =>
                                          playerRef.current?.seekTo(
                                              startMs / 1000,
                                          )
                            }
                        />
                    )}
                </>
            ) : (
                <Card>
                    <CardContent className="py-16 text-center">
                        <p className="text-muted-foreground">
                            Select a recording to view details and transcription
                        </p>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
