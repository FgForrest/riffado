"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
    RecordingPlayer,
    type RecordingPlayerHandle,
} from "@/components/dashboard/recording-player";
import { RecordingPlayerHeader } from "@/components/dashboard/recording-player-header";
import {
    TranscriptionPanel,
    type TranscriptOption,
} from "@/components/dashboard/transcription-panel";
import { LocalTime } from "@/components/local-time";
import { EraseRecordingMenu } from "@/components/recordings/erase-recording-menu";
import { RecordingFolderTags } from "@/components/recordings/recording-folder-tags";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranscribeQueue } from "@/hooks/use-transcribe-queue";
import { getApiErrorMessage } from "@/lib/api-errors";
import type { FolderOrganization } from "@/types/folder";
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
    initialFolderOrganization: FolderOrganization;
}

export function RecordingWorkstation({
    recording,
    transcription,
    transcripts,
    initialPlaybackSpeed,
    initialVolume,
    initialAutoPlayNext,
    scrubberStyle,
    initialFolderOrganization,
}: RecordingWorkstationProps) {
    const i18n = useExtracted();
    const { push, refresh } = useRouter();
    const [filename, setFilename] = useState(recording.filename);
    const [folderOrganization, setFolderOrganization] =
        useState<FolderOrganization>(initialFolderOrganization);
    const playerRef = useRef<RecordingPlayerHandle>(null);
    const { inFlightActions, observeTranscriptionById, transcribeById } =
        useTranscribeQueue({ onTranscribeComplete: refresh });
    const isTranscribing = inFlightActions.get(recording.id) === "transcribing";

    useEffect(() => {
        setFilename(recording.filename);
    }, [recording.filename]);

    useEffect(() => {
        setFolderOrganization(initialFolderOrganization);
    }, [initialFolderOrganization]);

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
        toast.success(i18n("Recording deleted"));
        push("/dashboard");
        refresh();
    }, [recording.id, refresh, push, i18n]);

    const handleFolderAssignment = useCallback(
        async (folderId: string, assigned: boolean) => {
            const previous = folderOrganization.assignments;
            setFolderOrganization((current) => ({
                ...current,
                assignments: assigned
                    ? [
                          ...current.assignments,
                          { recordingId: recording.id, folderId },
                      ]
                    : current.assignments.filter(
                          (item) =>
                              item.recordingId !== recording.id ||
                              item.folderId !== folderId,
                      ),
            }));
            const response = await fetch(
                `/api/recordings/${recording.id}/folders`,
                {
                    method: assigned ? "POST" : "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ folderId }),
                },
            );
            if (!response.ok) {
                setFolderOrganization((current) => ({
                    ...current,
                    assignments: previous,
                }));
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not update folder assignment"),
                    ),
                );
            }
        },
        [folderOrganization.assignments, recording.id, i18n],
    );

    return (
        <div className="bg-background">
            <div className="container mx-auto max-w-6xl px-4 py-6">
                <div className="mb-4">
                    <Button
                        onClick={() => push("/dashboard")}
                        variant="ghost"
                        size="sm"
                        className="-ml-2 gap-1.5 text-muted-foreground"
                    >
                        <ArrowLeft className="size-4" />{" "}
                        {i18n("Back to recordings")}
                    </Button>
                </div>

                <div className="space-y-6">
                    <RecordingPlayerHeader
                        recording={displayRecording}
                        onRenamed={handleRenamed}
                        action={
                            <EraseRecordingMenu
                                recording={displayRecording}
                                onDeleteLocal={handleDelete}
                                onChanged={refresh}
                            />
                        }
                    />
                    <RecordingFolderTags
                        recordingId={recording.id}
                        folders={folderOrganization.folders}
                        assignments={folderOrganization.assignments}
                        onSelectFolder={(folder) =>
                            push(
                                `/dashboard?folder=${encodeURIComponent(folder.id)}`,
                            )
                        }
                        onAdd={(_recordingId, folderId) =>
                            handleFolderAssignment(folderId, true)
                        }
                        onRemove={(_recordingId, folderId) =>
                            handleFolderAssignment(folderId, false)
                        }
                    />
                    {!displayRecording.audioReaped && (
                        <RecordingPlayer
                            ref={playerRef}
                            recording={displayRecording}
                            initialPlaybackSpeed={initialPlaybackSpeed}
                            initialVolume={initialVolume}
                            initialAutoPlayNext={initialAutoPlayNext}
                            scrubberStyle={scrubberStyle}
                        />
                    )}
                    {(!displayRecording.audioReaped ||
                        displayRecording.hasTranscript !== false) && (
                        <TranscriptionPanel
                            key={`${displayRecording.id}:${displayRecording.audioReaped ? 1 : 0}:${displayRecording.hasTranscript ? 1 : 0}:${displayRecording.hasSummary ? 1 : 0}`}
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
                                          playerRef.current?.seekTo(
                                              startMs / 1000,
                                          )
                            }
                            getPlaybackMs={() =>
                                (playerRef.current?.getCurrentTime() ?? 0) *
                                1000
                            }
                        />
                    )}

                    {/* Metadata */}
                    <Card>
                        <CardHeader>
                            <CardTitle>{i18n("Details")}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                <div>
                                    <div className="text-muted-foreground text-xs mb-1">
                                        {i18n("Duration")}
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
                                        {i18n("File Size")}
                                    </div>
                                    <div className="font-medium">
                                        {(
                                            recording.filesize /
                                            (1024 * 1024)
                                        ).toFixed(2)}{" "}
                                        {i18n("MB")}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground text-xs mb-1">
                                        {i18n("Device")}
                                    </div>
                                    <div className="font-mono text-xs truncate">
                                        {recording.deviceSn}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground text-xs mb-1">
                                        {i18n("Date")}
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
