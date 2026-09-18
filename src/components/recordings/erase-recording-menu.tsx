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
import { useExtracted } from "next-intl";
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
    const i18n = useExtracted();
    const [operation, setOperation] = useState<EraseOperation | null>(null);
    const [confirmText, setConfirmText] = useState("");
    const [working, setWorking] = useState(false);
    const isPlaudRecording = recording.deviceSn !== "local";
    const operationCopy: Record<
        Exclude<EraseOperation, "restore-audio">,
        { title: string; description: string; action: string; success: string }
    > = {
        audio: {
            title: i18n("Erase local audio for this recording?"),
            description: i18n(
                "Only the locally stored audio for the selected recording will be removed. Its transcripts and summaries stay available, and all other recordings remain unchanged. Riffado will not download this audio again automatically.",
            ),
            action: i18n("Erase audio"),
            success: i18n("Local audio erased"),
        },
        transcript: {
            title: i18n("Erase all transcripts for this recording?"),
            description: i18n(
                "All Plaud and custom transcripts, speaker assignments, and exported transcript files for the selected recording will be removed. Its existing summaries and all other recordings remain unchanged.",
            ),
            action: i18n("Erase transcripts"),
            success: i18n("Transcripts erased"),
        },
        summary: {
            title: i18n("Erase all summaries for this recording?"),
            description: i18n(
                "All Plaud and custom summaries and exported summary files for the selected recording will be removed. Its transcripts and all other recordings remain unchanged.",
            ),
            action: i18n("Erase summaries"),
            success: i18n("Summaries erased"),
        },
        local: {
            title: i18n("Delete all local data for this recording?"),
            description: i18n(
                "All data stored by Riffado for the selected recording will be removed: audio, transcripts, summaries, metadata, speaker assignments, and exported files. All other recordings remain unchanged. The Plaud original stays in your account and will not be synced back automatically.",
            ),
            action: i18n("Delete all local data"),
            success: i18n("All local data deleted"),
        },
        plaud: {
            title: i18n("Move this recording's Plaud original to Trash?"),
            description: i18n(
                "Only the Plaud original for the selected recording will be moved to Trash. Its local Riffado data and all other recordings remain unchanged. Plaud requires a separate action in its Trash to delete the recording permanently.",
            ),
            action: i18n("Move Plaud original to Trash"),
            success: i18n("Moved Plaud original to Trash"),
        },
        everywhere: {
            title: i18n("Delete this recording everywhere?"),
            description: i18n(
                "Only the selected recording will be affected. Its Plaud original will be moved to Trash, then all of its local data and exported files will be removed from Riffado. All other recordings remain unchanged. This cannot be undone from Riffado.",
            ),
            action: i18n("Delete everywhere"),
            success: i18n("Recording deleted everywhere"),
        },
    };

    const selectOperation = (next: EraseOperation) => {
        setConfirmText("");
        setOperation(next);
    };

    const restoreAudio = async () => {
        setWorking(true);
        try {
            await postOperation(recording.id, "restore-audio");
            toast.success(i18n("Audio restored from Plaud"));
            onChanged();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Audio restore failed"),
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
                toast.success(operationCopy[operation].success);
                onChanged();
            }
            setOperation(null);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Erase operation failed"),
            );
        } finally {
            setWorking(false);
        }
    };

    const copy =
        operation && operation !== "restore-audio"
            ? operationCopy[operation]
            : null;
    const requiresTitle = operation === "everywhere";
    const confirmed = !requiresTitle || confirmText === recording.filename;

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        className="h-11 gap-2.5 rounded-lg px-4 text-muted-foreground hover:text-destructive"
                        disabled={working}
                        aria-label={i18n("Erase recording artifacts")}
                    >
                        {working ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Trash2 className="size-4" />
                        )}
                        <span className="hidden sm:inline">
                            {i18n("Erase")}
                        </span>
                        <ChevronDown className="hidden size-4 sm:block" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel>
                        {i18n("Local artifacts")}
                    </DropdownMenuLabel>
                    {recording.audioReaped && isPlaudRecording ? (
                        <DropdownMenuItem onSelect={() => void restoreAudio()}>
                            <RotateCcw className="size-4" />{" "}
                            {i18n("Restore audio from Plaud")}
                        </DropdownMenuItem>
                    ) : (
                        <DropdownMenuItem
                            disabled={recording.audioReaped}
                            onSelect={() => selectOperation("audio")}
                        >
                            <FileAudio className="size-4" />{" "}
                            {i18n("Erase local audio")}
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                        disabled={recording.hasTranscript === false}
                        onSelect={() => selectOperation("transcript")}
                    >
                        <FileText className="size-4" />{" "}
                        {i18n("Erase transcripts")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        disabled={recording.hasSummary === false}
                        onSelect={() => selectOperation("summary")}
                    >
                        <Sparkles className="size-4" />{" "}
                        {i18n("Erase summaries")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => selectOperation("local")}>
                        <FolderX className="size-4" />{" "}
                        {i18n("Delete all local data")}
                    </DropdownMenuItem>
                    {isPlaudRecording && (
                        <>
                            <DropdownMenuItem
                                onSelect={() => selectOperation("plaud")}
                            >
                                <CloudOff className="size-4" />{" "}
                                {i18n("Move Plaud original to Trash")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => selectOperation("everywhere")}
                            >
                                <Trash2 className="size-4" />{" "}
                                {i18n("Delete everywhere")}
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
                                        {i18n("Type")}{" "}
                                        <strong>{recording.filename}</strong>{" "}
                                        {i18n("to confirm.")}
                                    </p>
                                    <Input
                                        value={confirmText}
                                        onChange={(event) =>
                                            setConfirmText(event.target.value)
                                        }
                                        autoComplete="off"
                                        aria-label={i18n(
                                            "Recording title confirmation",
                                        )}
                                    />
                                </div>
                            )}
                            <DialogFooter>
                                <Button
                                    variant="outline"
                                    onClick={() => setOperation(null)}
                                    disabled={working}
                                >
                                    {i18n("Cancel")}
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
