"use client";

import { Folder, FolderPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";

interface RecordingFolderTagsProps {
    recordingId: string;
    folders: RecordingFolder[];
    assignments: RecordingFolderAssignment[];
    onSelectFolder: (folder: RecordingFolder) => void;
    onAdd: (recordingId: string, folderId: string) => Promise<void>;
    onRemove: (recordingId: string, folderId: string) => Promise<void>;
}

export function RecordingFolderTags({
    recordingId,
    folders,
    assignments,
    onSelectFolder,
    onAdd,
    onRemove,
}: RecordingFolderTagsProps) {
    const assignedIds = new Set(
        assignments
            .filter((assignment) => assignment.recordingId === recordingId)
            .map((assignment) => assignment.folderId),
    );
    const assigned = folders.filter((folder) => assignedIds.has(folder.id));
    const available = folders.filter(
        (folder) => folder.kind !== "private" && !assignedIds.has(folder.id),
    );

    return (
        <fieldset className="flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
            <legend className="sr-only">Folders</legend>
            {assigned.map((folder) => (
                <span
                    key={folder.id}
                    className="inline-flex h-7 items-center overflow-hidden rounded-full border border-primary/20 bg-primary/5 text-xs"
                >
                    <button
                        type="button"
                        onClick={() => onSelectFolder(folder)}
                        className="inline-flex h-full items-center gap-1.5 px-2.5 text-foreground hover:bg-primary/10"
                    >
                        <Folder className="size-3.5 text-primary" />
                        {folder.name}
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            void onRemove(recordingId, folder.id).catch(
                                () => {},
                            );
                        }}
                        className="inline-flex h-full items-center border-l border-primary/15 px-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Remove from ${folder.name}`}
                    >
                        <X className="size-3.5" />
                    </button>
                </span>
            ))}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 rounded-full border border-dashed px-2.5 text-xs text-muted-foreground"
                    >
                        <FolderPlus className="size-3.5" />
                        Add to folder
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="start"
                    className="max-h-72 overflow-y-auto"
                >
                    <DropdownMenuLabel>Folders</DropdownMenuLabel>
                    {available.map((folder) => (
                        <DropdownMenuItem
                            key={folder.id}
                            onSelect={() => {
                                void onAdd(recordingId, folder.id).catch(
                                    () => {},
                                );
                            }}
                        >
                            <Folder />
                            {folder.name}
                        </DropdownMenuItem>
                    ))}
                    {available.length === 0 && (
                        <DropdownMenuItem disabled>
                            No other folders
                        </DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
        </fieldset>
    );
}
