"use client";

import {
    ArrowLeft,
    Download,
    Folder,
    MoreHorizontal,
    Pencil,
    Play,
    RefreshCw,
    Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/format-bytes";
import { formatDateTime } from "@/lib/format-date";
import { formatDurationMs } from "@/lib/format-duration";
import { recordingAudioDownloadPath } from "@/lib/recordings/filename";
import { cn } from "@/lib/utils";
import type { DateTimeFormat } from "@/types/common";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";
import type { Recording } from "@/types/recording";

interface FolderRecordingPaneProps {
    folder: RecordingFolder;
    folders: RecordingFolder[];
    assignments: RecordingFolderAssignment[];
    recordings: Recording[];
    dateTimeFormat: DateTimeFormat;
    onSelectRecording: (recording: Recording) => void;
    onRenameFolder: (folderId: string, name: string) => Promise<void>;
    onDeleteFolder: (folderId: string) => Promise<void>;
    hiddenOnMobile: boolean;
    onBackToFolders: () => void;
}

export function FolderRecordingPane({
    folder,
    folders,
    assignments,
    recordings,
    dateTimeFormat,
    onSelectRecording,
    onRenameFolder,
    onDeleteFolder,
    hiddenOnMobile,
    onBackToFolders,
}: FolderRecordingPaneProps) {
    const confirm = useConfirm();
    const [renameOpen, setRenameOpen] = useState(false);
    const [draft, setDraft] = useState(folder.name);
    const [saving, setSaving] = useState(false);

    const folderRecordings = useMemo(() => {
        if (folder.kind === "private") return recordings;
        const ids = new Set(
            assignments
                .filter((assignment) => assignment.folderId === folder.id)
                .map((assignment) => assignment.recordingId),
        );
        return recordings.filter((recording) => ids.has(recording.id));
    }, [assignments, folder, recordings]);

    const path = useMemo(() => {
        const byId = new Map(folders.map((item) => [item.id, item]));
        const result: RecordingFolder[] = [];
        let current: RecordingFolder | undefined = folder;
        while (current) {
            result.unshift(current);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return result;
    }, [folder, folders]);

    const submitRename = async () => {
        if (!draft.trim()) return;
        setSaving(true);
        try {
            await onRenameFolder(folder.id, draft);
            setRenameOpen(false);
        } catch {
            return;
        } finally {
            setSaving(false);
        }
    };

    return (
        <div
            className={cn(
                "space-y-6 lg:col-span-2 lg:block lg:self-start",
                hiddenOnMobile && "hidden",
            )}
        >
            <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onBackToFolders}
                className="-ml-2 h-9 gap-1 px-2 lg:hidden"
            >
                <ArrowLeft />
                Back to folders
            </Button>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex items-center gap-3">
                        <Folder className="size-8 shrink-0 text-primary" />
                        <h1 className="truncate text-2xl font-semibold tracking-tight">
                            {folder.name}
                        </h1>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
                        {path.map((item, index) => (
                            <span
                                key={item.id}
                                className="flex items-center gap-1"
                            >
                                {index > 0 && <span>/</span>}
                                <span>{item.name}</span>
                            </span>
                        ))}
                        <span className="mx-1">·</span>
                        <span>
                            {folderRecordings.length} recording
                            {folderRecordings.length === 1 ? "" : "s"}
                        </span>
                    </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9"
                        disabled
                        title="Coming soon"
                    >
                        <RefreshCw />
                        Synchronize
                    </Button>
                    {folder.kind === "custom" && (
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-9"
                                onClick={() => {
                                    setDraft(folder.name);
                                    setRenameOpen(true);
                                }}
                            >
                                <Pencil />
                                Rename
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-9 text-destructive hover:text-destructive"
                                onClick={() => {
                                    void confirm({
                                        title: `Delete “${folder.name}”?`,
                                        description:
                                            "This folder and all its subfolders will be deleted. Recordings stay intact; only their folder assignments are removed.",
                                        confirmLabel: "Delete folder",
                                        pendingLabel: "Deleting…",
                                        destructive: true,
                                        onConfirm: () =>
                                            onDeleteFolder(folder.id),
                                    });
                                }}
                            >
                                <Trash2 />
                                Delete
                            </Button>
                        </>
                    )}
                </div>
            </div>

            <Card hasNoPadding>
                <CardContent className="p-0">
                    <div className="grid grid-cols-[minmax(0,1fr)_9rem_6rem_6rem_2.5rem] gap-4 border-b bg-muted/20 px-5 py-3 text-xs font-medium text-muted-foreground max-md:grid-cols-[minmax(0,1fr)_5rem_2.5rem]">
                        <span>Title</span>
                        <span className="max-md:hidden">Date</span>
                        <span>Duration</span>
                        <span className="max-md:hidden">Size</span>
                        <span />
                    </div>
                    <div className="divide-y">
                        {folderRecordings.map((recording) => (
                            <div
                                key={recording.id}
                                className="grid grid-cols-[minmax(0,1fr)_9rem_6rem_6rem_2.5rem] items-center gap-4 px-5 py-3 transition-colors hover:bg-muted/30 max-md:grid-cols-[minmax(0,1fr)_5rem_2.5rem]"
                            >
                                <button
                                    type="button"
                                    onClick={() => onSelectRecording(recording)}
                                    className="flex min-w-0 items-center gap-3 text-left"
                                >
                                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                                        <Play className="ml-0.5 size-4 fill-current" />
                                    </span>
                                    <span className="truncate text-sm font-medium">
                                        {recording.filename}
                                    </span>
                                </button>
                                <span className="text-xs text-muted-foreground max-md:hidden">
                                    {formatDateTime(
                                        recording.startTime,
                                        dateTimeFormat,
                                    )}
                                </span>
                                <span className="text-xs tabular-nums text-muted-foreground">
                                    {formatDurationMs(recording.duration)}
                                </span>
                                <span className="text-xs tabular-nums text-muted-foreground max-md:hidden">
                                    {formatBytes(recording.filesize)}
                                </span>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={`Actions for ${recording.filename}`}
                                        >
                                            <MoreHorizontal />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuItem
                                            onSelect={() =>
                                                onSelectRecording(recording)
                                            }
                                        >
                                            <Play />
                                            Open
                                        </DropdownMenuItem>
                                        {!recording.audioReaped && (
                                            <DropdownMenuItem
                                                onSelect={() => {
                                                    window.location.assign(
                                                        recordingAudioDownloadPath(
                                                            recording.id,
                                                        ),
                                                    );
                                                }}
                                            >
                                                <Download />
                                                Download audio
                                            </DropdownMenuItem>
                                        )}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        ))}
                    </div>
                    {folderRecordings.length === 0 && (
                        <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                            <Folder className="mb-3 size-9 text-muted-foreground/60" />
                            <p className="text-sm font-medium">
                                This folder is empty
                            </p>
                            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                                Add a recording from its detail view. Recordings
                                can appear in more than one folder.
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Rename folder</DialogTitle>
                        <DialogDescription>
                            Choose a clear name for this folder.
                        </DialogDescription>
                    </DialogHeader>
                    <Input
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        maxLength={100}
                        aria-label="Folder name"
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && draft.trim()) {
                                event.preventDefault();
                                void submitRename();
                            }
                        }}
                    />
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={saving}
                            onClick={() => setRenameOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            disabled={saving || !draft.trim()}
                            onClick={() => void submitRename()}
                        >
                            {saving ? "Renaming…" : "Rename"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
