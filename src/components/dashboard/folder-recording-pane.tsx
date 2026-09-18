"use client";

import {
    ArrowDown,
    ArrowLeft,
    ArrowUp,
    ArrowUpDown,
    Download,
    Folder,
    MoreHorizontal,
    Pencil,
    Play,
    Trash2,
} from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useMemo, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { FolderExportActions } from "@/components/dashboard/folder-export-actions";
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
import { recordingIdsVisibleInFolder } from "@/lib/folders/hierarchy";
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

type RecordingSortColumn = "title" | "date" | "duration" | "size";
type SortDirection = "asc" | "desc";

const RECORDING_DRAG_TYPE = "application/x-riffado-recording";

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
    filesystemExportsAvailable: boolean;
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
    filesystemExportsAvailable,
}: FolderRecordingPaneProps) {
    const i18n = useExtracted();
    const locale = useLocale();
    const confirm = useConfirm();
    const [renameOpen, setRenameOpen] = useState(false);
    const [draft, setDraft] = useState(folder.name);
    const [saving, setSaving] = useState(false);
    const [sort, setSort] = useState<{
        column: RecordingSortColumn;
        direction: SortDirection;
    }>({ column: "date", direction: "desc" });

    const folderRecordings = useMemo(() => {
        const ids = recordingIdsVisibleInFolder(
            folders,
            assignments,
            folder,
            recordings.map((recording) => recording.id),
        );
        const matching = recordings.filter((recording) =>
            ids.has(recording.id),
        );
        const direction = sort.direction === "asc" ? 1 : -1;
        return [...matching].sort((left, right) => {
            let difference: number;
            switch (sort.column) {
                case "title":
                    difference = left.filename.localeCompare(right.filename);
                    break;
                case "duration":
                    difference = left.duration - right.duration;
                    break;
                case "size":
                    difference = left.filesize - right.filesize;
                    break;
                default:
                    difference =
                        Date.parse(left.startTime) -
                        Date.parse(right.startTime);
            }
            return difference * direction || left.id.localeCompare(right.id);
        });
    }, [assignments, folder, folders, recordings, sort]);

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

    const assignedFoldersByRecording = useMemo(() => {
        const foldersById = new Map(folders.map((item) => [item.id, item]));
        const result = new Map<string, RecordingFolder[]>();
        for (const assignment of assignments) {
            const assignedFolder = foldersById.get(assignment.folderId);
            if (!assignedFolder || assignedFolder.kind === "private") continue;
            const assigned = result.get(assignment.recordingId) ?? [];
            assigned.push(assignedFolder);
            result.set(assignment.recordingId, assigned);
        }
        return result;
    }, [assignments, folders]);

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

    const changeSort = (column: RecordingSortColumn) => {
        setSort((current) =>
            current.column === column
                ? {
                      column,
                      direction: current.direction === "asc" ? "desc" : "asc",
                  }
                : {
                      column,
                      direction: column === "title" ? "asc" : "desc",
                  },
        );
    };

    const sortHeader = (
        column: RecordingSortColumn,
        label: string,
        className?: string,
    ) => {
        const active = sort.column === column;
        const Icon = active
            ? sort.direction === "asc"
                ? ArrowUp
                : ArrowDown
            : ArrowUpDown;
        return (
            <button
                type="button"
                className={cn(
                    "inline-flex items-center gap-1 text-left transition-colors hover:text-foreground",
                    active && "text-foreground",
                    className,
                )}
                onClick={() => changeSort(column)}
                aria-label={
                    active
                        ? i18n("Sort by {label}, {direction}", {
                              label,
                              direction:
                                  sort.direction === "asc"
                                      ? i18n("ascending")
                                      : i18n("descending"),
                          })
                        : i18n("Sort by {label}", { label })
                }
            >
                {label}
                <Icon className="size-3" />
            </button>
        );
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
                <ArrowLeft /> {i18n("Back to folders")}
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
                            {i18n(
                                "{count, plural, one {# recording} other {# recordings}}",
                                { count: folderRecordings.length },
                            )}
                        </span>
                    </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                    <FolderExportActions
                        folder={folder}
                        filesystemAvailable={filesystemExportsAvailable}
                        privateTree={path[0]?.kind === "private"}
                    />
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
                                <Pencil /> {i18n("Rename")}
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-9 text-destructive hover:text-destructive"
                                onClick={() => {
                                    void confirm({
                                        title: i18n("Delete “{name}”?", {
                                            name: folder.name,
                                        }),
                                        description: i18n(
                                            "This folder and all its subfolders will be deleted. Recordings stay intact; only their folder assignments are removed.",
                                        ),
                                        confirmLabel: i18n("Delete folder"),
                                        pendingLabel: i18n("Deleting…"),
                                        destructive: true,
                                        onConfirm: () =>
                                            onDeleteFolder(folder.id),
                                    });
                                }}
                            >
                                <Trash2 /> {i18n("Delete")}
                            </Button>
                        </>
                    )}
                </div>
            </div>

            <Card hasNoPadding>
                <CardContent className="p-0">
                    <div className="grid grid-cols-[minmax(0,1fr)_9rem_6rem_6rem_2.5rem] gap-4 border-b bg-muted/20 px-5 py-3 text-xs font-medium text-muted-foreground max-md:grid-cols-[minmax(0,1fr)_5rem_2.5rem]">
                        {sortHeader("title", i18n("Title"))}
                        {sortHeader("date", i18n("Date"), "max-md:hidden")}
                        {sortHeader("duration", i18n("Duration"))}
                        {sortHeader("size", i18n("Size"), "max-md:hidden")}
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
                                    draggable
                                    onDragStart={(event) => {
                                        event.dataTransfer.setData(
                                            RECORDING_DRAG_TYPE,
                                            recording.id,
                                        );
                                        event.dataTransfer.effectAllowed =
                                            "copy";
                                    }}
                                    onClick={() => onSelectRecording(recording)}
                                    aria-label={i18n("Open {title}", {
                                        title: recording.filename,
                                    })}
                                    className="flex min-w-0 cursor-grab items-center gap-3 text-left active:cursor-grabbing"
                                >
                                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                                        <Play className="ml-0.5 size-4 fill-current" />
                                    </span>
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm font-medium">
                                            {recording.filename}
                                        </span>
                                        {(assignedFoldersByRecording.get(
                                            recording.id,
                                        )?.length ?? 0) > 0 && (
                                            <span className="mt-1 flex flex-wrap gap-1">
                                                {assignedFoldersByRecording
                                                    .get(recording.id)
                                                    ?.map((assignedFolder) => (
                                                        <span
                                                            key={
                                                                assignedFolder.id
                                                            }
                                                            className="rounded-full border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-[10px] font-normal leading-none text-muted-foreground"
                                                        >
                                                            {
                                                                assignedFolder.name
                                                            }
                                                        </span>
                                                    ))}
                                            </span>
                                        )}
                                    </span>
                                </button>
                                <span className="text-xs text-muted-foreground max-md:hidden">
                                    {formatDateTime(
                                        recording.startTime,
                                        dateTimeFormat,
                                        locale,
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
                                            aria-label={i18n(
                                                "Actions for {title}",
                                                { title: recording.filename },
                                            )}
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
                                            <Play /> {i18n("Open")}
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
                                                <Download />{" "}
                                                {i18n("Download audio")}
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
                                {i18n("This folder is empty")}
                            </p>
                            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                                {i18n(
                                    "Drag a recording onto this folder, or add it from its detail view. Recordings can appear in more than one folder.",
                                )}
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{i18n("Rename folder")}</DialogTitle>
                        <DialogDescription>
                            {i18n("Choose a clear name for this folder.")}
                        </DialogDescription>
                    </DialogHeader>
                    <Input
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        maxLength={100}
                        aria-label={i18n("Folder name")}
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
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            type="button"
                            disabled={saving || !draft.trim()}
                            onClick={() => void submitRename()}
                        >
                            {saving ? i18n("Renaming…") : i18n("Rename")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
