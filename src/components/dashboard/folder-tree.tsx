"use client";

import {
    ChevronDown,
    ChevronRight,
    Folder,
    FolderInput,
    FolderPlus,
    History,
    MoreHorizontal,
    Pencil,
    RefreshCw,
    Search,
    Trash2,
    X,
} from "lucide-react";
import { type DragEvent, useMemo, useState } from "react";
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
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";
import type { Recording } from "@/types/recording";

type FolderAction =
    | { kind: "create"; folder: RecordingFolder }
    | { kind: "rename"; folder: RecordingFolder }
    | { kind: "move"; folder: RecordingFolder }
    | null;

type DropPlacement = "before" | "inside" | "after";

const RECORDING_DRAG_TYPE = "application/x-riffado-recording";

interface DropTarget {
    folderId: string;
    placement: DropPlacement;
}

interface FolderTreeProps {
    folders: RecordingFolder[];
    assignments: RecordingFolderAssignment[];
    recordings: Recording[];
    selectedFolderId: string | null;
    onRecent: () => void;
    onSelectFolder: (folder: RecordingFolder) => void;
    onCreateFolder: (parentId: string, name: string) => Promise<void>;
    onRenameFolder: (folderId: string, name: string) => Promise<void>;
    onMoveFolder: (
        folderId: string,
        parentId: string,
        beforeId?: string | null,
    ) => Promise<void>;
    onDeleteFolder: (folderId: string) => Promise<void>;
    onAssignRecording: (recordingId: string, folderId: string) => Promise<void>;
}

export function FolderTree({
    folders,
    assignments,
    recordings,
    selectedFolderId,
    onRecent,
    onSelectFolder,
    onCreateFolder,
    onRenameFolder,
    onMoveFolder,
    onDeleteFolder,
    onAssignRecording,
}: FolderTreeProps) {
    const confirm = useConfirm();
    const [query, setQuery] = useState("");
    const [expanded, setExpanded] = useState<Set<string>>(
        () => new Set(folders.map((folder) => folder.id)),
    );
    const [action, setAction] = useState<FolderAction>(null);
    const [draft, setDraft] = useState("");
    const [moveParentId, setMoveParentId] = useState("");
    const [saving, setSaving] = useState(false);
    const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
    const [recordingDropFolderId, setRecordingDropFolderId] = useState<
        string | null
    >(null);

    const childrenByParent = useMemo(() => {
        const result = new Map<string | null, RecordingFolder[]>();
        for (const folder of folders) {
            const children = result.get(folder.parentId) ?? [];
            children.push(folder);
            result.set(folder.parentId, children);
        }
        for (const children of result.values()) {
            children.sort((left, right) => {
                const rootOrder = { private: 0, public: 1, custom: 2 };
                const kindDiff = rootOrder[left.kind] - rootOrder[right.kind];
                return (
                    kindDiff ||
                    left.sortOrder - right.sortOrder ||
                    left.name.localeCompare(right.name)
                );
            });
        }
        return result;
    }, [folders]);

    const countByFolder = useMemo(() => {
        const counts = new Map<string, number>();
        const recordingIds = new Set(
            recordings.map((recording) => recording.id),
        );
        for (const assignment of assignments) {
            if (!recordingIds.has(assignment.recordingId)) continue;
            counts.set(
                assignment.folderId,
                (counts.get(assignment.folderId) ?? 0) + 1,
            );
        }
        const privateRoot = folders.find((folder) => folder.kind === "private");
        if (privateRoot) counts.set(privateRoot.id, recordings.length);
        return counts;
    }, [assignments, folders, recordings]);

    const matchingIds = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        if (!normalized) return null;
        const byId = new Map(folders.map((folder) => [folder.id, folder]));
        const result = new Set<string>();
        for (const folder of folders) {
            if (!folder.name.toLowerCase().includes(normalized)) continue;
            let current: RecordingFolder | undefined = folder;
            while (current) {
                result.add(current.id);
                current = current.parentId
                    ? byId.get(current.parentId)
                    : undefined;
            }
        }
        return result;
    }, [folders, query]);

    const descendantsOfAction = useMemo(() => {
        if (action?.kind !== "move") return new Set<string>();
        const descendants = new Set<string>([action.folder.id]);
        const visit = (parentId: string) => {
            for (const child of childrenByParent.get(parentId) ?? []) {
                descendants.add(child.id);
                visit(child.id);
            }
        };
        visit(action.folder.id);
        return descendants;
    }, [action, childrenByParent]);

    const openAction = (
        kind: Exclude<FolderAction, null>["kind"],
        folder: RecordingFolder,
    ) => {
        setAction({ kind, folder });
        setDraft(kind === "rename" ? folder.name : "");
        setMoveParentId(folder.parentId ?? "");
    };

    const submitAction = async () => {
        if (!action) return;
        setSaving(true);
        try {
            if (action.kind === "create") {
                await onCreateFolder(action.folder.id, draft);
                setExpanded((current) =>
                    new Set(current).add(action.folder.id),
                );
            } else if (action.kind === "rename") {
                await onRenameFolder(action.folder.id, draft);
            } else if (moveParentId) {
                await onMoveFolder(action.folder.id, moveParentId);
            }
            setAction(null);
        } catch {
            return;
        } finally {
            setSaving(false);
        }
    };

    const dropPlacementFor = (
        event: DragEvent<HTMLButtonElement>,
        target: RecordingFolder,
    ): DropPlacement => {
        const dragged = folders.find((folder) => folder.id === draggedFolderId);
        if (!dragged || target.kind !== "custom") return "inside";
        const bounds = event.currentTarget.getBoundingClientRect();
        const position = (event.clientY - bounds.top) / bounds.height;
        if (dragged.parentId === target.parentId) {
            return position < 0.5 ? "before" : "after";
        }
        if (position < 0.25) return "before";
        if (position > 0.75) return "after";
        return "inside";
    };

    const dropFolder = (
        draggedId: string,
        target: RecordingFolder,
        placement: DropPlacement,
    ) => {
        if (draggedId === target.id) return;
        if (placement === "inside") {
            void onMoveFolder(draggedId, target.id, null).catch(() => {});
            return;
        }
        if (!target.parentId) return;
        const siblings = (childrenByParent.get(target.parentId) ?? []).filter(
            (folder) => folder.id !== draggedId,
        );
        const targetIndex = siblings.findIndex(
            (folder) => folder.id === target.id,
        );
        if (targetIndex < 0) return;
        const beforeId =
            placement === "before"
                ? target.id
                : (siblings[targetIndex + 1]?.id ?? null);
        void onMoveFolder(draggedId, target.parentId, beforeId).catch(() => {});
    };

    const renderFolder = (folder: RecordingFolder, depth: number) => {
        if (matchingIds && !matchingIds.has(folder.id)) return null;
        const children = childrenByParent.get(folder.id) ?? [];
        const isExpanded = query.trim() ? true : expanded.has(folder.id);
        const canExpand = children.length > 0;
        return (
            <div key={folder.id}>
                <div
                    className={cn(
                        "group/folder flex items-center rounded-md border border-transparent pr-1 transition-colors",
                        selectedFolderId === folder.id &&
                            "border-primary/20 bg-primary/10",
                        dropTarget?.folderId === folder.id &&
                            dropTarget.placement === "inside" &&
                            "border-primary bg-primary/10",
                        dropTarget?.folderId === folder.id &&
                            dropTarget.placement === "before" &&
                            "border-t-primary",
                        dropTarget?.folderId === folder.id &&
                            dropTarget.placement === "after" &&
                            "border-b-primary",
                        recordingDropFolderId === folder.id &&
                            "border-primary bg-primary/10 ring-1 ring-primary/30",
                    )}
                    style={{ paddingLeft: `${depth * 20 + 4}px` }}
                >
                    {canExpand ? (
                        <button
                            type="button"
                            className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={
                                isExpanded ? "Collapse folder" : "Expand folder"
                            }
                            onClick={() => {
                                setExpanded((current) => {
                                    const next = new Set(current);
                                    if (next.has(folder.id)) {
                                        next.delete(folder.id);
                                    } else {
                                        next.add(folder.id);
                                    }
                                    return next;
                                });
                            }}
                        >
                            {isExpanded ? (
                                <ChevronDown className="size-4" />
                            ) : (
                                <ChevronRight className="size-4" />
                            )}
                        </button>
                    ) : (
                        <span className="size-7 shrink-0" aria-hidden="true" />
                    )}
                    <button
                        type="button"
                        draggable={folder.kind === "custom"}
                        onDragStart={(event) => {
                            setDraggedFolderId(folder.id);
                            event.dataTransfer.setData(
                                "application/x-riffado-folder",
                                folder.id,
                            );
                            event.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => {
                            setDraggedFolderId(null);
                            setDropTarget(null);
                        }}
                        onDragOver={(event) => {
                            const isRecordingDrag = Array.from(
                                event.dataTransfer.types ?? [],
                            ).includes(RECORDING_DRAG_TYPE);
                            if (isRecordingDrag) {
                                if (folder.kind === "private") return;
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "copy";
                                setDropTarget(null);
                                setRecordingDropFolderId(folder.id);
                                return;
                            }
                            if (!draggedFolderId) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            setRecordingDropFolderId(null);
                            setDropTarget({
                                folderId: folder.id,
                                placement: dropPlacementFor(event, folder),
                            });
                        }}
                        onDragLeave={() => {
                            setDropTarget(null);
                            setRecordingDropFolderId(null);
                        }}
                        onDrop={(event) => {
                            const recordingId = Array.from(
                                event.dataTransfer.types ?? [],
                            ).includes(RECORDING_DRAG_TYPE)
                                ? event.dataTransfer.getData(
                                      RECORDING_DRAG_TYPE,
                                  )
                                : "";
                            if (recordingId) {
                                event.preventDefault();
                                setDropTarget(null);
                                setRecordingDropFolderId(null);
                                if (folder.kind !== "private") {
                                    void onAssignRecording(
                                        recordingId,
                                        folder.id,
                                    ).catch(() => {});
                                }
                                return;
                            }
                            event.preventDefault();
                            const draggedId =
                                draggedFolderId ||
                                event.dataTransfer.getData(
                                    "application/x-riffado-folder",
                                );
                            const placement =
                                dropTarget?.folderId === folder.id
                                    ? dropTarget.placement
                                    : dropPlacementFor(event, folder);
                            setDropTarget(null);
                            setDraggedFolderId(null);
                            if (draggedId) {
                                dropFolder(draggedId, folder, placement);
                            }
                        }}
                        onClick={() => onSelectFolder(folder)}
                        aria-label={`${folder.name}, ${countByFolder.get(folder.id) ?? 0} recording${(countByFolder.get(folder.id) ?? 0) === 1 ? "" : "s"}`}
                        className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-sm"
                    >
                        <Folder
                            className={cn(
                                "size-5 shrink-0 text-primary",
                                folder.kind !== "custom" && "fill-primary/10",
                            )}
                        />
                        <span className="truncate">{folder.name}</span>
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            {countByFolder.get(folder.id) ?? 0}
                        </span>
                    </button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="size-7 opacity-100 sm:opacity-0 sm:group-hover/folder:opacity-100 data-[state=open]:opacity-100"
                                aria-label={`Folder actions for ${folder.name}`}
                            >
                                <MoreHorizontal className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem
                                onSelect={() => openAction("create", folder)}
                            >
                                <FolderPlus />
                                New subfolder
                            </DropdownMenuItem>
                            {folder.kind === "custom" && (
                                <>
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            openAction("rename", folder)
                                        }
                                    >
                                        <Pencil />
                                        Rename
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            openAction("move", folder)
                                        }
                                    >
                                        <FolderInput />
                                        Move to…
                                    </DropdownMenuItem>
                                </>
                            )}
                            <DropdownMenuItem disabled title="Coming soon">
                                <RefreshCw />
                                Synchronize
                            </DropdownMenuItem>
                            {folder.kind === "custom" && (
                                <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        variant="destructive"
                                        onSelect={(event) => {
                                            event.preventDefault();
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
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                {isExpanded &&
                    children.map((child) => renderFolder(child, depth + 1))}
            </div>
        );
    };

    const customFolderCount = folders.filter(
        (folder) => folder.kind === "custom",
    ).length;

    return (
        <>
            <Card hasNoPadding>
                <CardContent className="p-0">
                    <div className="flex flex-col gap-2 border-b p-3">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={query}
                                onChange={(event) =>
                                    setQuery(event.target.value)
                                }
                                placeholder="Search folders..."
                                aria-label="Search folders"
                                className="h-9 pl-8 pr-8"
                            />
                            {query && (
                                <button
                                    type="button"
                                    onClick={() => setQuery("")}
                                    aria-label="Clear search"
                                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                                >
                                    <X className="size-4" />
                                </button>
                            )}
                        </div>
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>
                                {customFolderCount} folder
                                {customFolderCount === 1 ? "" : "s"}
                            </span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={onRecent}
                            >
                                <History className="size-3.5" />
                                Recent
                            </Button>
                        </div>
                    </div>
                    <div className="p-2">
                        {(childrenByParent.get(null) ?? []).map((folder) =>
                            renderFolder(folder, 0),
                        )}
                        {matchingIds?.size === 0 && (
                            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                                No folders match your search.
                            </p>
                        )}
                    </div>
                </CardContent>
            </Card>

            <Dialog
                open={action !== null}
                onOpenChange={(open) => {
                    if (!open && !saving) setAction(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {action?.kind === "create"
                                ? "Create subfolder"
                                : action?.kind === "rename"
                                  ? "Rename folder"
                                  : "Move folder"}
                        </DialogTitle>
                        <DialogDescription>
                            {action?.kind === "create"
                                ? `Add a folder inside ${action.folder.name}.`
                                : action?.kind === "rename"
                                  ? "Choose a clear name for this folder."
                                  : "Choose the new parent folder."}
                        </DialogDescription>
                    </DialogHeader>
                    {action?.kind === "move" ? (
                        <select
                            value={moveParentId}
                            onChange={(event) =>
                                setMoveParentId(event.target.value)
                            }
                            aria-label="Destination folder"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {folders
                                .filter(
                                    (folder) =>
                                        !descendantsOfAction.has(folder.id),
                                )
                                .map((folder) => (
                                    <option key={folder.id} value={folder.id}>
                                        {folder.name}
                                    </option>
                                ))}
                        </select>
                    ) : (
                        <Input
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            maxLength={100}
                            placeholder="Folder name"
                            aria-label="Folder name"
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && draft.trim()) {
                                    event.preventDefault();
                                    void submitAction();
                                }
                            }}
                        />
                    )}
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={saving}
                            onClick={() => setAction(null)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            disabled={
                                saving ||
                                (action?.kind === "move"
                                    ? !moveParentId
                                    : !draft.trim())
                            }
                            onClick={() => void submitAction()}
                        >
                            {saving
                                ? "Saving…"
                                : action?.kind === "create"
                                  ? "Create"
                                  : action?.kind === "rename"
                                    ? "Rename"
                                    : "Move"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
