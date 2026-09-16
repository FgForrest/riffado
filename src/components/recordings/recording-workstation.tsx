"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
    RecordingPlayer,
    type RecordingPlayerHandle,
} from "@/components/dashboard/recording-player";
import {
    TranscriptionPanel,
    type TranscriptOption,
} from "@/components/dashboard/transcription-panel";
import { LocalTime } from "@/components/local-time";
import { DownloadAudioButton } from "@/components/recordings/download-audio-button";
import { EraseRecordingMenu } from "@/components/recordings/erase-recording-menu";
import { RecordingTitle } from "@/components/recordings/recording-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranscribeQueue } from "@/hooks/use-transcribe-queue";
import type { Recording } from "@/types/recording";

interface Transcription {
    text?: string;
    detectedLanguage?: string;
    transcriptionType?: string;
}

interface RecordingWorkstationProps {
    recording: Recording;
    transcription?: Transcription;
    /** All transcripts (one per source) for the in-panel source switcher. */
    transcripts?: TranscriptOption[];
    /**
     * User playback preferences forwarded into the embedded
     * RecordingPlayer. Server-resolved (with the same defaults as the
     * dashboard's Workstation) so callers don't need to know the
     * shape of user_settings; the page server-component reads them
     * once and hands them down here.
     */
    initialPlaybackSpeed?: number;
    initialVolume?: number;
    initialAutoPlayNext?: boolean;
    scrubberStyle?: "waveform" | "slider";
}

export function RecordingWorkstation({
    recording,
    transcription,
    transcripts,
    initialPlaybackSpeed,
    initialVolume,
    initialAutoPlayNext,
    scrubberStyle,
}: RecordingWorkstationProps) {
    const { push, refresh } = useRouter();
    const [filename, setFilename] = useState(recording.filename);
    const playerRef = useRef<RecordingPlayerHandle>(null);
    const { inFlightActions, observeTranscriptionById, transcribeById } =
        useTranscribeQueue({ onTranscribeComplete: refresh });
    const isTranscribing = inFlightActions.get(recording.id) === "transcribing";

    useEffect(() => {
        setFilename(recording.filename);
    }, [recording.filename]);

    useEffect(() => {
        void observeTranscriptionById(recording.id);
    }, [observeTranscriptionById, recording.id]);

    const displayRecording = useMemo(
        () =>
            filename === recording.filename
                ? recording
                : { ...recording, filename },
        [recording, filename],
    );

    const handleRenamed = useCallback(
        (next: string) => {
            setFilename(next);
            refresh();
        },
        [refresh],
    );

    const handleTranscribe = useCallback(
        async (attributionSource?: string) => {
            await transcribeById(recording.id, attributionSource);
        },
        [recording.id, transcribeById],
    );

    const handleDelete = useCallback(async () => {
        const response = await fetch(`/api/recordings/${recording.id}`, {
            method: "DELETE",
        });
        if (!response.ok) {
            const error = (await response.json().catch(() => null)) as {
                error?: string;
            } | null;
            throw new Error(error?.error || "Failed to delete recording");
        }
        toast.success("Recording deleted");
        push("/dashboard");
        refresh();
    }, [recording.id, refresh, push]);

    return (
        <div className="bg-background">
            <div className="container mx-auto px-4 py-6 max-w-4xl">
                {/* Header */}
                <div className="flex items-center gap-4 mb-6">
                    <Button
                        onClick={() => push("/dashboard")}
                        variant="outline"
                        size="icon"
                    >
                        <ArrowLeft className="size-4" />
                    </Button>
                    <div className="flex-1 min-w-0">
                        <h1 className="min-w-0">
                            <RecordingTitle
                                recordingId={recording.id}
                                filename={filename}
                                onRenamed={handleRenamed}
                                className="text-3xl font-semibold"
                            />
                        </h1>
                        <p className="text-muted-foreground text-sm mt-1">
                            <LocalTime value={recording.startTime} />
                        </p>
                    </div>
                    {!recording.audioReaped && (
                        <DownloadAudioButton recordingId={recording.id} />
                    )}
                    <EraseRecordingMenu
                        recording={displayRecording}
                        onDeleteLocal={handleDelete}
                        onChanged={refresh}
                    />
                </div>

                {/* Content */}
                <div className="space-y-6">
                    <RecordingPlayer
                        ref={playerRef}
                        recording={displayRecording}
                        initialPlaybackSpeed={initialPlaybackSpeed}
                        initialVolume={initialVolume}
                        initialAutoPlayNext={initialAutoPlayNext}
                        scrubberStyle={scrubberStyle}
                        onRenamed={handleRenamed}
                    />
                    <TranscriptionPanel
                        recording={displayRecording}
                        transcription={transcription}
                        transcripts={transcripts}
                        isTranscribing={isTranscribing}
                        onTranscribe={handleTranscribe}
                        onTranscribeComplete={refresh}
                        onSeekToTurn={
                            recording.audioReaped
                                ? undefined
                                : (startMs) =>
                                      playerRef.current?.seekTo(startMs / 1000)
                        }
                    />

                    {/* Metadata */}
                    <Card>
                        <CardHeader>
                            <CardTitle>Details</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                <div>
                                    <div className="text-muted-foreground text-xs mb-1">
                                        Duration
                                    </div>
                                    <div className="font-medium">
                                        {Math.floor(recording.duration / 60000)}
                                        :
                                        {((recording.duration % 60000) / 1000)
                                            .toFixed(0)
                                            .padStart(2, "0")}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground text-xs mb-1">
                                        File Size
                                    </div>
                                    <div className="font-medium">
                                        {(
                                            recording.filesize /
                                            (1024 * 1024)
                                        ).toFixed(2)}{" "}
                                        MB
                                    </div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground text-xs mb-1">
                                        Device
                                    </div>
                                    <div className="font-mono text-xs truncate">
                                        {recording.deviceSn}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground text-xs mb-1">
                                        Date
                                    </div>
                                    <div className="font-medium">
                                        <LocalTime
                                            value={recording.startTime}
                                            variant="date"
                                        />
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}
