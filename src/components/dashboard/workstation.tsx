"use client";

import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CommandPalette } from "@/components/dashboard/command-palette";
import { FolderRecordingPane } from "@/components/dashboard/folder-recording-pane";
import { FolderTree } from "@/components/dashboard/folder-tree";
import { PlaudReconnectBanner } from "@/components/dashboard/plaud-reconnect-banner";
import {
    RecordingList,
    type RecordingListHandle,
} from "@/components/dashboard/recording-list";
import { ShortcutsDialog } from "@/components/dashboard/shortcuts-dialog";
import type { TranscriptOption } from "@/components/dashboard/transcription-panel";
import { TrialBanner } from "@/components/dashboard/trial-banner";
import { WorkstationDetailPane } from "@/components/dashboard/workstation-detail-pane";
import { WorkstationEmptyState } from "@/components/dashboard/workstation-empty-state";
import { WorkstationHeader } from "@/components/dashboard/workstation-header";
import { OnboardingDialog } from "@/components/onboarding-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { useAutoSync } from "@/hooks/use-auto-sync";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { useTheme } from "@/hooks/use-theme";
import { useTranscribeQueue } from "@/hooks/use-transcribe-queue";
import { useUploadQueue } from "@/hooks/use-upload-queue";
import { getApiErrorMessage } from "@/lib/api-errors";
import {
    requestNotificationPermission,
    showNewRecordingNotification,
    showSyncCompleteNotification,
} from "@/lib/notifications/browser";
import {
    applyFilenameOverrides,
    reconcileFilenameOverrides,
} from "@/lib/recordings/filename-overrides";
import type { InitialSettings } from "@/lib/settings/initial-settings";
import { SYNC_CONFIG } from "@/lib/sync-config";
import { cn } from "@/lib/utils";
import type { FolderOrganization, RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

interface TranscriptionData {
    text?: string;
    language?: string;
    source?: string;
    provider?: string;
    model?: string;
    turns?: TranscriptOption["turns"];
}

interface Provider {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
    createdAt: Date;
}

const EMPTY_PROVIDERS: Provider[] = [];

interface WorkstationProps {
    recordings: Recording[];
    transcriptions: Map<string, TranscriptionData>;
    transcriptVariants?: Map<string, TranscriptOption[]>;
    /**
     * When true, an admin shortcut appears in the avatar menu. Set by
     * the server-rendered page based on env.ADMIN_EMAILS membership;
     * never trusted client-side -- the actual /admin gate runs
     * server-side.
     */
    isAdmin?: boolean;
    /**
     * Logged-in user's email. Passed down to the avatar menu for the
     * identity block. Server-supplied -- never derive from any client
     * state, which would risk a stale or attacker-influenced value.
     */
    userEmail?: string | null;
    initialSettings: InitialSettings;
    /**
     * True when Plaud has rejected the stored token (connection row carries
     * an `invalidatedAt`). Seeds the reconnect banner on first paint; the
     * live sync result takes over once a sync runs. Server-supplied.
     */
    plaudNeedsReconnect: boolean;
    /**
     * True when running in Riffado's hosted mode (`IS_HOSTED=true`).
     * Forwarded into SettingsDialog so hosted-only UI gating reflects
     * the deployment mode. Server-supplied; never derive client-side.
     * Required (no default) so a future caller can't silently regress
     * hosted-mode behavior by forgetting to thread the value through.
     */
    isHosted: boolean;
    initialFolderOrganization: FolderOrganization;
}

/**
 * Top-level dashboard component. Composition root for the recording
 * list, the detail pane (player + transcription), and the four
 * modals (CommandPalette, ShortcutsDialog, SettingsDialog,
 * OnboardingDialog).
 *
 * State ownership is split:
 *  - selection / mobile master-detail toggle live here
 *  - uploads -> useUploadQueue
 *  - transcribes -> useTranscribeQueue
 *  - sync loop -> useAutoSync
 *  - theme -> useTheme
 *  - keyboard nav -> useListKeyboardNav
 *  - deletes stay here because they need access to currentRecording
 *    / visibleRecordings to pick the next selection.
 */
export function Workstation({
    recordings,
    transcriptions,
    transcriptVariants,
    isAdmin = false,
    userEmail = null,
    initialSettings,
    plaudNeedsReconnect,
    isHosted,
    initialFolderOrganization,
}: WorkstationProps) {
    const { refresh } = useRouter();
    const [currentRecording, setCurrentRecording] = useState<Recording | null>(
        recordings.length > 0 ? recordings[0] : null,
    );
    const [settingsOpen, setSettingsOpen] = useState(false);
    // Auto-opens on first paint when the account hasn't finished
    // onboarding yet (server-supplied truth, re-evaluated on every fresh
    // navigation to this page). Everyone must finish onboarding --
    // `mandatory` below keeps it non-dismissible in that case.
    const [onboardingOpen, setOnboardingOpen] = useState(
        () => !initialSettings.onboardingCompleted,
    );
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
    const [filenameOverrides, setFilenameOverrides] = useState<
        Map<string, string>
    >(() => new Map());
    // On <lg viewports the list and detail panes can't coexist -- we
    // toggle between them instead of stacking. Desktop ignores this
    // state entirely (both panes render via the grid).
    const [mobileView, setMobileView] = useState<"list" | "detail">("list");
    const [providers, setProviders] = useState<Provider[]>(EMPTY_PROVIDERS);
    const [libraryMode, setLibraryMode] = useState<"recent" | "organize">(
        "recent",
    );
    const [folderOrganization, setFolderOrganization] =
        useState<FolderOrganization>(initialFolderOrganization);
    const [selectedFolderId, setSelectedFolderId] = useState<string | null>(
        null,
    );

    const { theme, setTheme } = useTheme(initialSettings.theme);
    const listRef = useRef<RecordingListHandle>(null);
    const initialFolderQueryHandled = useRef(false);

    useEffect(() => {
        if (initialFolderQueryHandled.current) return;
        initialFolderQueryHandled.current = true;
        const folderId = new URLSearchParams(window.location.search).get(
            "folder",
        );
        if (
            folderId &&
            initialFolderOrganization.folders.some(
                (folder) => folder.id === folderId,
            )
        ) {
            setLibraryMode("organize");
            setSelectedFolderId(folderId);
            setMobileView("detail");
        }
    }, [initialFolderOrganization.folders]);

    useEffect(() => {
        setFolderOrganization(initialFolderOrganization);
    }, [initialFolderOrganization]);

    // Filter out optimistically-hidden (deleted) rows.
    const visibleRecordings = useMemo(
        () =>
            applyFilenameOverrides(
                recordings.filter((r) => !hiddenIds.has(r.id)),
                filenameOverrides,
            ),
        [recordings, hiddenIds, filenameOverrides],
    );

    const currentTranscription = currentRecording
        ? transcriptions.get(currentRecording.id)
        : undefined;
    const currentTranscriptVariants = currentRecording
        ? transcriptVariants?.get(currentRecording.id)
        : undefined;

    const selectedRecording = currentRecording
        ? (visibleRecordings.find((r) => r.id === currentRecording.id) ??
          currentRecording)
        : null;
    const selectedFolder = selectedFolderId
        ? (folderOrganization.folders.find(
              (folder) => folder.id === selectedFolderId,
          ) ?? null)
        : null;

    // Keep currentRecording in sync with the recordings prop (updated
    // after refresh()). If the previously-selected recording is no
    // longer present (e.g. just deleted), clear the selection.
    useEffect(() => {
        setCurrentRecording((prev) => {
            if (!prev) return prev;
            const updated = recordings.find((r) => r.id === prev.id);
            return updated ?? null;
        });
        // When server data comes back, clear any optimistic hides whose
        // rows no longer exist server-side (deletion confirmed).
        setHiddenIds((prev) => {
            if (prev.size === 0) return prev;
            const next = new Set<string>();
            const ids = new Set(recordings.map((r) => r.id));
            for (const id of prev) {
                if (ids.has(id)) next.add(id); // still present -> keep hidden until confirmed
            }
            return next.size === prev.size ? prev : next;
        });
        setFilenameOverrides((prev) =>
            reconcileFilenameOverrides(recordings, prev),
        );
    }, [recordings]);

    const {
        isAutoSyncing,
        lastSyncTime,
        nextSyncTime,
        lastSyncResult,
        manualSync,
    } = useAutoSync({
        interval: initialSettings.syncInterval ?? SYNC_CONFIG.defaultInterval,
        minInterval: SYNC_CONFIG.minInterval,
        syncOnMount: initialSettings.syncOnMount,
        syncOnVisibilityChange: initialSettings.syncOnVisibilityChange,
        enabled: initialSettings.autoSyncEnabled,
        onSuccess: (newRecordings) => {
            if (initialSettings.syncNotifications !== false) {
                if (newRecordings > 0) {
                    toast.success(
                        `Synced ${newRecordings} new recording${newRecordings !== 1 ? "s" : ""}`,
                    );
                } else {
                    toast.success("Sync complete - no new recordings");
                }
            }
            if (initialSettings.browserNotifications) {
                (async () => {
                    const granted = await requestNotificationPermission();
                    if (!granted) return;
                    if (newRecordings > 0) {
                        showNewRecordingNotification(newRecordings);
                    } else {
                        showSyncCompleteNotification();
                    }
                })();
            }
        },
        onError: (error) => {
            toast.error(error);
        },
    });

    const handleSync = useCallback(async () => {
        await manualSync();
    }, [manualSync]);

    // Prefer the live sync result once we have one; fall back to the
    // server-rendered flag on first paint (before any sync runs). A
    // change in `plaudNeedsReconnect` only happens when fresh server
    // truth arrives (e.g. a `router.refresh()` after another tab's sync
    // invalidated the token), so it always resets the override rather
    // than letting a stale client-side result keep masking it.
    const [reconnectOverride, setReconnectOverride] = useState<boolean | null>(
        null,
    );
    const prevPlaudNeedsReconnect = useRef(plaudNeedsReconnect);
    useEffect(() => {
        if (plaudNeedsReconnect !== prevPlaudNeedsReconnect.current) {
            prevPlaudNeedsReconnect.current = plaudNeedsReconnect;
            setReconnectOverride(null);
        }
    }, [plaudNeedsReconnect]);
    useEffect(() => {
        if (typeof lastSyncResult?.needsReconnect === "boolean") {
            setReconnectOverride(lastSyncResult.needsReconnect);
        }
    }, [lastSyncResult]);
    const showReconnect = reconnectOverride ?? plaudNeedsReconnect;

    const handleReconnected = useCallback(() => {
        refresh();
        manualSync();
    }, [refresh, manualSync]);

    // Settings dialog needs the provider list at open-time so the
    // Providers section seeds correctly. Fetching on open (rather
    // than on mount) avoids loading a list the user may never see.
    useEffect(() => {
        if (settingsOpen) {
            fetch("/api/settings/ai/providers")
                .then((res) => res.json())
                .then((data) => setProviders(data.providers || []))
                .catch(() => setProviders([]));
        }
    }, [settingsOpen]);

    const {
        isUploading,
        pendingUploads,
        uploadInputRef,
        handleUpload,
        triggerUpload,
    } = useUploadQueue({ onUploadComplete: refresh });

    const { inFlightActions, observeTranscriptionById, transcribeById } =
        useTranscribeQueue({ onTranscribeComplete: refresh });

    useEffect(() => {
        if (currentRecording) {
            void observeTranscriptionById(currentRecording.id);
        }
    }, [currentRecording, observeTranscriptionById]);

    // Any transcribe in flight (across all recordings) blocks new
    // uploads. The previous `isTranscribing` boolean conflated "this
    // recording is being transcribed" with "some transcribe is
    // happening"; splitting them fixes a concurrency bug where two
    // pending transcribes would race each other's finally clauses.
    const anyTranscribing = Array.from(inFlightActions.values()).some(
        (kind) => kind === "transcribing",
    );
    const isCurrentTranscribing =
        currentRecording !== null &&
        inFlightActions.get(currentRecording.id) === "transcribing";
    const isProcessing = anyTranscribing || isUploading;

    const handleTranscribe = useCallback(
        async (attributionSource?: string) => {
            if (!currentRecording) return;
            await transcribeById(currentRecording.id, attributionSource);
        },
        [currentRecording, transcribeById],
    );

    const handleDelete = useCallback(
        async (recording: Recording) => {
            const id = recording.id;
            // Optimistic hide.
            setHiddenIds((prev) => new Set(prev).add(id));
            const wasCurrent = currentRecording?.id === id;
            if (wasCurrent) {
                const idx = visibleRecordings.findIndex((r) => r.id === id);
                const next =
                    visibleRecordings[idx + 1] ??
                    visibleRecordings[idx - 1] ??
                    null;
                setCurrentRecording(next);
            }
            try {
                const res = await fetch(`/api/recordings/${id}`, {
                    method: "DELETE",
                });
                if (!res.ok) throw new Error("Delete failed");
                if (posthog.__loaded) {
                    posthog.capture("recording_deleted");
                }
                toast.success("Recording deleted");
                refresh();
            } catch (err) {
                // Rollback
                setHiddenIds((prev) => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
                if (wasCurrent) setCurrentRecording(recording);
                throw err;
            }
        },
        [currentRecording, visibleRecordings, refresh],
    );

    const handleRenamed = useCallback(
        (filename: string) => {
            const id = currentRecording?.id;
            if (!id) return;
            setFilenameOverrides((prev) => new Map(prev).set(id, filename));
            refresh();
        },
        [currentRecording?.id, refresh],
    );

    const handleCreateFolder = useCallback(
        async (parentId: string, name: string) => {
            const response = await fetch("/api/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parentId, name }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        "Could not create folder",
                    ),
                );
                throw new Error("Could not create folder");
            }
            const { folder } = (await response.json()) as {
                folder: RecordingFolder;
            };
            setFolderOrganization((current) => ({
                ...current,
                folders: [...current.folders, folder],
            }));
            toast.success("Folder created");
        },
        [],
    );

    const handleRenameFolder = useCallback(
        async (folderId: string, name: string) => {
            const response = await fetch(`/api/folders/${folderId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        "Could not rename folder",
                    ),
                );
                throw new Error("Could not rename folder");
            }
            const { folder } = (await response.json()) as {
                folder: RecordingFolder;
            };
            setFolderOrganization((current) => ({
                ...current,
                folders: current.folders.map((item) =>
                    item.id === folder.id ? folder : item,
                ),
            }));
            toast.success("Folder renamed");
        },
        [],
    );

    const handleMoveFolder = useCallback(
        async (folderId: string, parentId: string) => {
            const previous = folderOrganization;
            setFolderOrganization((current) => ({
                ...current,
                folders: current.folders.map((folder) =>
                    folder.id === folderId ? { ...folder, parentId } : folder,
                ),
            }));
            const response = await fetch(`/api/folders/${folderId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parentId }),
            });
            if (!response.ok) {
                setFolderOrganization(previous);
                toast.error(
                    await getApiErrorMessage(response, "Could not move folder"),
                );
                throw new Error("Could not move folder");
            }
            toast.success("Folder moved");
        },
        [folderOrganization],
    );

    const handleDeleteFolder = useCallback(
        async (folderId: string) => {
            const deletedIds = new Set<string>([folderId]);
            let foundChild = true;
            while (foundChild) {
                foundChild = false;
                for (const folder of folderOrganization.folders) {
                    if (
                        folder.parentId &&
                        deletedIds.has(folder.parentId) &&
                        !deletedIds.has(folder.id)
                    ) {
                        deletedIds.add(folder.id);
                        foundChild = true;
                    }
                }
            }
            const response = await fetch(`/api/folders/${folderId}`, {
                method: "DELETE",
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        "Could not delete folder",
                    ),
                );
                throw new Error("Could not delete folder");
            }
            setFolderOrganization((current) => {
                return {
                    folders: current.folders.filter(
                        (folder) => !deletedIds.has(folder.id),
                    ),
                    assignments: current.assignments.filter(
                        (assignment) => !deletedIds.has(assignment.folderId),
                    ),
                };
            });
            setSelectedFolderId((current) => {
                if (!current || !deletedIds.has(current)) return current;
                return (
                    folderOrganization.folders.find(
                        (folder) => folder.kind === "private",
                    )?.id ?? null
                );
            });
            toast.success("Folder deleted");
        },
        [folderOrganization.folders],
    );

    const handleFolderAssignment = useCallback(
        async (recordingId: string, folderId: string, assigned: boolean) => {
            const assignment = { recordingId, folderId };
            const previous = folderOrganization.assignments;
            setFolderOrganization((current) => ({
                ...current,
                assignments: assigned
                    ? current.assignments.some(
                          (item) =>
                              item.recordingId === recordingId &&
                              item.folderId === folderId,
                      )
                        ? current.assignments
                        : [...current.assignments, assignment]
                    : current.assignments.filter(
                          (item) =>
                              item.recordingId !== recordingId ||
                              item.folderId !== folderId,
                      ),
            }));
            const response = await fetch(
                `/api/recordings/${recordingId}/folders`,
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
                        assigned
                            ? "Could not add recording to folder"
                            : "Could not remove recording from folder",
                    ),
                );
                throw new Error("Could not update folder assignment");
            }
        },
        [folderOrganization.assignments],
    );

    // Keyboard shortcuts (global). Disabled while any modal is open
    // so the modal owns keyboard focus exclusively. The shortcuts
    // dialog itself uses these very keys to navigate its rows.
    useListKeyboardNav({
        onNext: () => listRef.current?.next(),
        onPrev: () => listRef.current?.prev(),
        onFocusSearch: () => listRef.current?.focusSearch(),
        onOpenPalette: () => setPaletteOpen(true),
        onOpenShortcuts: () => setShortcutsOpen(true),
        onOpenSettings: () => setSettingsOpen(true),
        enabled:
            !settingsOpen && !onboardingOpen && !paletteOpen && !shortcutsOpen,
    });

    return (
        <>
            <div className="bg-background">
                <div className="container mx-auto max-w-7xl px-4 py-6">
                    <TrialBanner isHosted={isHosted} />
                    <WorkstationHeader
                        isAdmin={isAdmin}
                        userEmail={userEmail}
                        initialTheme={initialSettings.theme}
                        lastSyncTime={lastSyncTime}
                        nextSyncTime={nextSyncTime}
                        isAutoSyncing={isAutoSyncing}
                        lastSyncResult={lastSyncResult}
                        onSync={handleSync}
                        isUploading={isUploading}
                        isProcessing={isProcessing}
                        uploadInputRef={uploadInputRef}
                        onTriggerUpload={triggerUpload}
                        onUploadInputChange={handleUpload}
                        onOpenPalette={() => setPaletteOpen(true)}
                        onOpenSettings={() => setSettingsOpen(true)}
                        onOpenShortcuts={() => setShortcutsOpen(true)}
                    />

                    <PlaudReconnectBanner
                        show={showReconnect}
                        onReconnected={handleReconnected}
                    />

                    {visibleRecordings.length === 0 &&
                    pendingUploads.length === 0 ? (
                        <WorkstationEmptyState
                            isSyncing={isAutoSyncing}
                            onSync={handleSync}
                            onUpload={triggerUpload}
                        />
                    ) : (
                        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                            {/*
                              Mobile master/detail: on <lg, only one
                              pane renders at a time. `mobileView ===
                              "detail"` hides the list (via `hidden`)
                              while keeping its state mounted, so
                              scroll position, search query, and
                              selection survive the back-navigation.
                              The `lg:block` override brings the list
                              back on desktop where both panes coexist.
                            */}
                            <div
                                className={cn(
                                    "lg:col-span-1 lg:block",
                                    mobileView === "detail" && "hidden",
                                )}
                            >
                                {libraryMode === "recent" ? (
                                    <RecordingList
                                        ref={listRef}
                                        recordings={visibleRecordings}
                                        transcriptions={transcriptions}
                                        currentRecording={currentRecording}
                                        pendingUploads={pendingUploads}
                                        inFlightActions={inFlightActions}
                                        onSelect={(r) => {
                                            setCurrentRecording(r);
                                            setMobileView("detail");
                                        }}
                                        onDelete={handleDelete}
                                        onOrganize={() => {
                                            setLibraryMode("organize");
                                            setSelectedFolderId(null);
                                        }}
                                        initialDateTimeFormat={
                                            initialSettings.dateTimeFormat
                                        }
                                        initialSortOrder={
                                            initialSettings.recordingListSortOrder
                                        }
                                        initialChunkSize={
                                            initialSettings.itemsPerPage
                                        }
                                    />
                                ) : (
                                    <FolderTree
                                        folders={folderOrganization.folders}
                                        assignments={
                                            folderOrganization.assignments
                                        }
                                        recordings={visibleRecordings}
                                        selectedFolderId={selectedFolderId}
                                        onRecent={() => {
                                            setLibraryMode("recent");
                                            setSelectedFolderId(null);
                                            setCurrentRecording(
                                                visibleRecordings[0] ?? null,
                                            );
                                            setMobileView("list");
                                        }}
                                        onSelectFolder={(folder) => {
                                            setSelectedFolderId(folder.id);
                                            setMobileView("detail");
                                        }}
                                        onCreateFolder={handleCreateFolder}
                                        onRenameFolder={handleRenameFolder}
                                        onMoveFolder={handleMoveFolder}
                                        onDeleteFolder={handleDeleteFolder}
                                    />
                                )}
                            </div>

                            {libraryMode === "organize" && selectedFolder ? (
                                <FolderRecordingPane
                                    folder={selectedFolder}
                                    folders={folderOrganization.folders}
                                    assignments={folderOrganization.assignments}
                                    recordings={visibleRecordings}
                                    dateTimeFormat={
                                        initialSettings.dateTimeFormat
                                    }
                                    onSelectRecording={(recording) => {
                                        setCurrentRecording(recording);
                                        setSelectedFolderId(null);
                                    }}
                                    onRenameFolder={handleRenameFolder}
                                    onDeleteFolder={handleDeleteFolder}
                                    hiddenOnMobile={mobileView === "list"}
                                    onBackToFolders={() =>
                                        setMobileView("list")
                                    }
                                />
                            ) : (
                                <WorkstationDetailPane
                                    currentRecording={selectedRecording}
                                    currentTranscription={currentTranscription}
                                    transcripts={currentTranscriptVariants}
                                    isCurrentTranscribing={
                                        isCurrentTranscribing
                                    }
                                    visibleRecordings={visibleRecordings}
                                    onTranscribe={handleTranscribe}
                                    onTranscribeComplete={refresh}
                                    onSelectRecording={setCurrentRecording}
                                    onRenamed={handleRenamed}
                                    onDelete={handleDelete}
                                    onArtifactsChanged={refresh}
                                    onBackToList={() => setMobileView("list")}
                                    hiddenOnMobile={mobileView === "list"}
                                    initialPlaybackSpeed={
                                        initialSettings.defaultPlaybackSpeed
                                    }
                                    initialVolume={
                                        initialSettings.defaultVolume
                                    }
                                    initialAutoPlayNext={
                                        initialSettings.autoPlayNext
                                    }
                                    scrubberStyle={
                                        initialSettings.playerScrubber
                                    }
                                    folders={folderOrganization.folders}
                                    folderAssignments={
                                        folderOrganization.assignments
                                    }
                                    onSelectFolder={(folder) => {
                                        setLibraryMode("organize");
                                        setSelectedFolderId(folder.id);
                                    }}
                                    onAddToFolder={(recordingId, folderId) =>
                                        handleFolderAssignment(
                                            recordingId,
                                            folderId,
                                            true,
                                        )
                                    }
                                    onRemoveFromFolder={(
                                        recordingId,
                                        folderId,
                                    ) =>
                                        handleFolderAssignment(
                                            recordingId,
                                            folderId,
                                            false,
                                        )
                                    }
                                />
                            )}
                        </div>
                    )}
                </div>
            </div>

            <CommandPalette
                open={paletteOpen}
                onOpenChange={setPaletteOpen}
                recordings={visibleRecordings}
                transcriptions={transcriptions}
                currentRecording={currentRecording}
                inFlightActions={inFlightActions}
                currentTheme={theme}
                dateTimeFormat={initialSettings.dateTimeFormat}
                onSelectRecording={(r) => {
                    setCurrentRecording(r);
                    setMobileView("detail");
                }}
                onSync={handleSync}
                onUpload={triggerUpload}
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenShortcuts={() => setShortcutsOpen(true)}
                onSetTheme={setTheme}
                onTranscribeRecording={transcribeById}
            />

            <ShortcutsDialog
                open={shortcutsOpen}
                onOpenChange={setShortcutsOpen}
            />

            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                initialProviders={providers}
                isHosted={isHosted}
                onReRunOnboarding={() => {
                    setSettingsOpen(false);
                    setOnboardingOpen(true);
                }}
                onPlaudReconnected={handleReconnected}
            />

            <OnboardingDialog
                open={onboardingOpen}
                onOpenChange={setOnboardingOpen}
                onComplete={() => {
                    setOnboardingOpen(false);
                    refresh();
                }}
                mandatory={!initialSettings.onboardingCompleted}
            />
        </>
    );
}
