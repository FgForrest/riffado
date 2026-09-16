"use client";

import {
    ChevronDown,
    CloudOff,
    FileAudio,
    FileText,
    FolderX,
    Loader2,
    RotateCcw,
    Sparkles,
    Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { Recording } from "@/types/recording";

type EraseOperation =
    | "audio"
    | "transcript"
    | "summary"
    | "local"
    | "plaud"
    | "everywhere"
    | "restore-audio";

interface EraseRecordingMenuProps {
    recording: Recording;
    onDeleteLocal: (recording: Recording) => Promise<void>;
    onChanged: () => void;
}

const OPERATION_COPY: Record<
    Exclude<EraseOperation, "restore-audio">,
    { title: string; description: string; action: string; success: string }
> = {
    audio: {
        title: "Erase local audio?",
        description:
            "The transcript and summaries stay available. Riffado will not download the audio again automatically.",
        action: "Erase audio",
        success: "Local audio erased",
    },
    transcript: {
        title: "Erase all transcripts?",
        description:
            "Plaud and custom transcripts, speaker assignments, and exported transcript files will be removed. Existing summaries stay available.",
        action: "Erase transcripts",
        success: "Transcripts erased",
    },
    summary: {
        title: "Erase all summaries?",
        description:
            "Plaud and custom summaries and their exported Markdown files will be removed. Transcripts stay available.",
        action: "Erase summaries",
        success: "Summaries erased",
    },
    local: {
        title: "Delete the local copy?",
        description:
            "Audio, transcripts, summaries, and exported files will be removed from Riffado. The Plaud copy stays in your account and will not be synced back automatically.",
        action: "Delete local copy",
        success: "Local copy deleted",
    },
    plaud: {
        title: "Move the Plaud copy to Trash?",
        description:
            "The local Riffado copy stays available. Plaud requires a separate action in its Trash to delete the recording permanently.",
        action: "Move to Plaud Trash",
        success: "Moved Plaud copy to Trash",
    },
    everywhere: {
        title: "Delete everywhere?",
        description:
            "The Plaud copy will be moved to Trash, then every local artifact and exported file will be removed from Riffado. This cannot be undone from Riffado.",
        action: "Delete everywhere",
        success: "Recording deleted everywhere",
    },
};

async function postOperation(
    recordingId: string,
    scope: "audio" | "transcript" | "summary" | "plaud" | "restore-audio",
): Promise<void> {
    const response = await fetch(`/api/recordings/${recordingId}/erase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
    });
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
            error?: string;
        } | null;
        throw new Error(body?.error || "Erase operation failed");
    }
}

export function EraseRecordingMenu({
    recording,
    onDeleteLocal,
    onChanged,
}: EraseRecordingMenuProps) {
    const [operation, setOperation] = useState<EraseOperation | null>(null);
    const [confirmText, setConfirmText] = useState("");
    const [working, setWorking] = useState(false);
    const isPlaudRecording = recording.deviceSn !== "local";

    const selectOperation = (next: EraseOperation) => {
        setConfirmText("");
        setOperation(next);
    };

    const restoreAudio = async () => {
        setWorking(true);
        try {
            await postOperation(recording.id, "restore-audio");
            toast.success("Audio restored from Plaud");
            onChanged();
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : "Audio restore failed",
            );
        } finally {
            setWorking(false);
        }
    };

    const execute = async () => {
        if (!operation || operation === "restore-audio") return;
        setWorking(true);
        try {
            if (operation === "local") {
                await onDeleteLocal(recording);
            } else if (operation === "everywhere") {
                await postOperation(recording.id, "plaud");
                await onDeleteLocal(recording);
            } else {
                await postOperation(recording.id, operation);
                toast.success(OPERATION_COPY[operation].success);
                onChanged();
            }
            setOperation(null);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Erase operation failed",
            );
        } finally {
            setWorking(false);
        }
    };

    const copy =
        operation && operation !== "restore-audio"
            ? OPERATION_COPY[operation]
            : null;
    const requiresTitle = operation === "everywhere";
    const confirmed = !requiresTitle || confirmText === recording.filename;

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-muted-foreground hover:text-destructive"
                        disabled={working}
                        aria-label="Erase recording artifacts"
                    >
                        {working ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Trash2 className="size-4" />
                        )}
                        <span className="hidden sm:inline">Erase</span>
                        <ChevronDown className="hidden size-3.5 sm:block" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel>Local artifacts</DropdownMenuLabel>
                    {recording.audioReaped && isPlaudRecording ? (
                        <DropdownMenuItem onSelect={() => void restoreAudio()}>
                            <RotateCcw className="size-4" />
                            Restore audio from Plaud
                        </DropdownMenuItem>
                    ) : (
                        <DropdownMenuItem
                            disabled={recording.audioReaped}
                            onSelect={() => selectOperation("audio")}
                        >
                            <FileAudio className="size-4" />
                            Erase local audio
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                        disabled={recording.hasTranscript === false}
                        onSelect={() => selectOperation("transcript")}
                    >
                        <FileText className="size-4" />
                        Erase transcripts
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        disabled={recording.hasSummary === false}
                        onSelect={() => selectOperation("summary")}
                    >
                        <Sparkles className="size-4" />
                        Erase summaries
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => selectOperation("local")}>
                        <FolderX className="size-4" />
                        Delete local copy
                    </DropdownMenuItem>
                    {isPlaudRecording && (
                        <>
                            <DropdownMenuItem
                                onSelect={() => selectOperation("plaud")}
                            >
                                <CloudOff className="size-4" />
                                Move Plaud copy to Trash
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => selectOperation("everywhere")}
                            >
                                <Trash2 className="size-4" />
                                Delete everywhere
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>

            <Dialog
                open={copy !== null}
                onOpenChange={(open) => {
                    if (!open && !working) setOperation(null);
                }}
            >
                <DialogContent>
                    {copy && (
                        <>
                            <DialogHeader>
                                <DialogTitle>{copy.title}</DialogTitle>
                                <DialogDescription>
                                    {copy.description}
                                </DialogDescription>
                            </DialogHeader>
                            {requiresTitle && (
                                <div className="space-y-2">
                                    <p className="text-sm text-muted-foreground">
                                        Type{" "}
                                        <strong>{recording.filename}</strong> to
                                        confirm.
                                    </p>
                                    <Input
                                        value={confirmText}
                                        onChange={(event) =>
                                            setConfirmText(event.target.value)
                                        }
                                        autoComplete="off"
                                        aria-label="Recording title confirmation"
                                    />
                                </div>
                            )}
                            <DialogFooter>
                                <Button
                                    variant="outline"
                                    onClick={() => setOperation(null)}
                                    disabled={working}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    variant="destructive"
                                    onClick={() => void execute()}
                                    disabled={working || !confirmed}
                                >
                                    {working && (
                                        <Loader2 className="size-4 animate-spin" />
                                    )}
                                    {copy.action}
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
