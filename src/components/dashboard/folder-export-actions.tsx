"use client";

import { FolderOpen, Plus, RefreshCw, Settings, Trash2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { GoogleConnectionPanel } from "@/components/integrations/google-connection-panel";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useGoogleConnection } from "@/hooks/use-google-connection";
import { getApiErrorMessage } from "@/lib/api-errors";
import type {
    DocumentFormat,
    ExportProvidersAvailability,
    FolderExportConfigurationDto,
    FolderExportProviderType,
} from "@/lib/folder-exports/types";
import {
    type PickerCredentials,
    pickDriveFolder,
} from "@/lib/integrations/google/picker-client";
import { followJob } from "@/lib/jobs/client";
import type { RecordingFolder } from "@/types/folder";

interface FolderExportActionsProps {
    folder: RecordingFolder;
    providers: ExportProvidersAvailability;
    privateTree: boolean;
}

interface FormState {
    id: string | null;
    provider: FolderExportProviderType;
    targetPath: string;
    driveFolder: { id: string; name: string } | null;
    transcriptFormat: DocumentFormat;
    summaryFormat: DocumentFormat;
    exportAudio: boolean;
    exportTranscript: boolean;
    exportSummary: boolean;
}

/**
 * Query parameter that reopens this dialog after Google's consent screen:
 * `<folderId>` on a new Drive export, `<folderId>.list` on the list.
 */
const REOPEN_PARAM = "googleExport";

function emptyForm(provider: FolderExportProviderType): FormState {
    return {
        id: null,
        provider,
        targetPath: "",
        driveFolder: null,
        transcriptFormat: "google_doc",
        summaryFormat: "google_doc",
        exportAudio: true,
        exportTranscript: true,
        exportSummary: true,
    };
}

function formFor(configuration: FolderExportConfigurationDto): FormState {
    const drive = configuration.googleDrive;
    return {
        id: configuration.id,
        provider: configuration.provider,
        targetPath:
            configuration.provider === "filesystem"
                ? configuration.targetPath
                : "",
        driveFolder: drive
            ? { id: drive.rootFolderId, name: drive.rootFolderName }
            : null,
        transcriptFormat: drive?.transcriptFormat ?? "markdown",
        summaryFormat: drive?.summaryFormat ?? "markdown",
        exportAudio: configuration.exportAudio,
        exportTranscript: configuration.exportTranscript,
        exportSummary: configuration.exportSummary,
    };
}

export function FolderExportActions({
    folder,
    providers,
    privateTree,
}: FolderExportActionsProps) {
    const i18n = useExtracted();
    const [open, setOpen] = useState(false);
    const [configurations, setConfigurations] = useState<
        FolderExportConfigurationDto[]
    >([]);
    const [applicableIds, setApplicableIds] = useState<string[]>([]);
    const [form, setForm] = useState<FormState | null>(null);
    const [saving, setSaving] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [picking, setPicking] = useState(false);
    const available = providers.filesystem || providers.googleDrive;
    const google = useGoogleConnection(providers.googleDrive && open);

    const load = useCallback(async () => {
        if (!available || !privateTree) {
            setConfigurations([]);
            setApplicableIds([]);
            return;
        }
        const response = await fetch(`/api/folders/${folder.id}/exports`);
        if (!response.ok) return;
        const data = (await response.json()) as {
            configured: FolderExportConfigurationDto[];
            applicableIds: string[];
        };
        setConfigurations(data.configured);
        setApplicableIds(data.applicableIds);
    }, [available, folder.id, privateTree]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        const url = new URL(window.location.href);
        const reopen = url.searchParams.get(REOPEN_PARAM);
        if (reopen !== folder.id && reopen !== `${folder.id}.list`) return;
        url.searchParams.delete(REOPEN_PARAM);
        window.history.replaceState(window.history.state, "", url);
        setForm(reopen === folder.id ? emptyForm("google-drive") : null);
        setOpen(true);
    }, [folder.id]);

    const update = (patch: Partial<FormState>) =>
        setForm((current) => (current ? { ...current, ...patch } : current));

    const connection = google.state?.connection ?? null;
    const driveReady = connection?.status === "active";

    const connectReturnTo = (view: "form" | "list") => () => {
        const url = new URL(window.location.href);
        url.searchParams.set("folder", folder.id);
        url.searchParams.set(
            REOPEN_PARAM,
            view === "form" ? folder.id : `${folder.id}.list`,
        );
        return `${url.pathname}${url.search}`;
    };
    const driveNeedsAttention =
        google.state !== null &&
        !driveReady &&
        configurations.some(
            (configuration) => configuration.provider === "google-drive",
        );

    const chooseDriveFolder = async () => {
        setPicking(true);
        try {
            const response = await fetch(
                "/api/integrations/google/picker-token",
            );
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not open Google Drive"),
                    ),
                );
                await google.refresh();
                return;
            }
            const credentials = (await response.json()) as PickerCredentials;
            // The dialog is modal: it would block the Picker's own frame.
            setOpen(false);
            const picked = await pickDriveFolder(
                credentials,
                i18n("Choose the folder to export into"),
            );
            if (picked) update({ driveFolder: picked });
        } catch (error) {
            console.error("[google] picker failed:", error);
            toast.error(i18n("Could not open Google Drive"));
        } finally {
            setOpen(true);
            setPicking(false);
        }
    };

    const save = async () => {
        if (!form) return;
        setSaving(true);
        const url = form.id
            ? `/api/folders/${folder.id}/exports/${form.id}`
            : `/api/folders/${folder.id}/exports`;
        const selection = {
            exportAudio: form.exportAudio,
            exportTranscript: form.exportTranscript,
            exportSummary: form.exportSummary,
        };
        try {
            const response = await fetch(url, {
                method: form.id ? "PATCH" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(
                    form.provider === "google-drive"
                        ? {
                              provider: "google-drive",
                              rootFolderId: form.driveFolder?.id ?? "",
                              transcriptFormat: form.transcriptFormat,
                              summaryFormat: form.summaryFormat,
                              ...selection,
                          }
                        : {
                              provider: "filesystem",
                              targetPath: form.targetPath,
                              ...selection,
                          },
                ),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not save export"),
                    ),
                );
                return;
            }
            setForm(null);
            await load();
            toast.success(i18n("Export saved and scheduled"));
        } finally {
            setSaving(false);
        }
    };

    const remove = async (id: string) => {
        const response = await fetch(
            `/api/folders/${folder.id}/exports/${id}`,
            { method: "DELETE" },
        );
        if (!response.ok) {
            toast.error(
                await getApiErrorMessage(
                    response,
                    i18n("Could not remove export"),
                ),
            );
            return;
        }
        await load();
        toast.success(i18n("Export removed"));
    };

    const synchronize = async () => {
        setSyncing(true);
        try {
            const response = await fetch(
                `/api/folders/${folder.id}/synchronize`,
                { method: "POST" },
            );
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not schedule synchronization"),
                    ),
                );
                return;
            }
            const { jobId } = (await response.json()) as { jobId: string };
            toast.success(i18n("Synchronization scheduled"));
            const result = await followJob(jobId);
            if (result?.status === "completed") {
                toast.success(i18n("Synchronization audit completed"));
            } else if (result?.status === "failed") {
                toast.error(result.error ?? i18n("Synchronization failed"));
            }
        } finally {
            setSyncing(false);
        }
    };

    const formatLabel = (format: DocumentFormat) => {
        switch (format) {
            case "markdown":
                return i18n("Markdown file");
            case "google_doc":
                return i18n("Google Doc");
            case "both":
                return i18n("Markdown file and Google Doc");
        }
    };

    const artifactLabels = (configuration: FolderExportConfigurationDto) =>
        [
            configuration.exportAudio && i18n("Audio"),
            configuration.exportTranscript && i18n("Transcript"),
            configuration.exportSummary && i18n("Summary"),
        ]
            .filter(Boolean)
            .join(", ");

    const targetLabel = (configuration: FolderExportConfigurationDto) =>
        configuration.googleDrive
            ? i18n("Google Drive: {folder}", {
                  folder: configuration.googleDrive.rootFolderName,
              })
            : configuration.targetPath;

    const canSave =
        form !== null &&
        !saving &&
        (form.exportAudio || form.exportTranscript || form.exportSummary) &&
        (form.provider === "filesystem"
            ? form.targetPath.trim().length > 0
            : form.driveFolder !== null && driveReady);

    return (
        <>
            {applicableIds.length > 0 && (
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9"
                    disabled={syncing}
                    onClick={() => void synchronize()}
                >
                    <RefreshCw
                        className={syncing ? "animate-spin" : undefined}
                    />
                    {syncing ? i18n("Synchronizing…") : i18n("Synchronize")}
                </Button>
            )}
            <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => setOpen(true)}
            >
                <Settings /> {i18n("Settings")}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-xl">
                    <DialogHeader>
                        <DialogTitle>
                            {i18n("Folder export settings")}
                        </DialogTitle>
                        <DialogDescription>
                            {i18n("Exports configured on")} {folder.name}{" "}
                            {i18n("apply to its complete subtree.")}
                        </DialogDescription>
                    </DialogHeader>
                    {!available ? (
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Folder export requires a self-hosted deployment with FILESYSTEM_EXPORT_ROOT or the Google integration configured.",
                            )}
                        </p>
                    ) : !privateTree ? (
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Exports can only be configured for Private folders.",
                            )}
                        </p>
                    ) : form ? (
                        <div className="space-y-5">
                            <div className="space-y-2">
                                <Label htmlFor="folder-export-provider">
                                    {i18n("Provider")}
                                </Label>
                                <Input
                                    id="folder-export-provider"
                                    value={
                                        form.provider === "google-drive"
                                            ? i18n("Google Drive")
                                            : i18n("Filesystem")
                                    }
                                    disabled
                                />
                            </div>
                            {form.provider === "filesystem" ? (
                                <div className="space-y-2">
                                    <Label htmlFor="folder-export-target">
                                        {i18n(
                                            "Destination under the configured export root",
                                        )}
                                    </Label>
                                    <Input
                                        id="folder-export-target"
                                        value={form.targetPath}
                                        placeholder={i18n("team-meetings")}
                                        onChange={(event) =>
                                            update({
                                                targetPath: event.target.value,
                                            })
                                        }
                                    />
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <div className="rounded-md border p-3">
                                        <GoogleConnectionPanel
                                            state={google.state}
                                            onChanged={() =>
                                                void google.refresh()
                                            }
                                            returnTo={connectReturnTo("form")}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>
                                            {i18n("Google Drive folder")}
                                        </Label>
                                        <div className="flex items-center gap-2">
                                            <span className="min-w-0 flex-1 truncate text-sm">
                                                {form.driveFolder?.name ??
                                                    i18n("No folder chosen")}
                                            </span>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                disabled={
                                                    !driveReady || picking
                                                }
                                                onClick={() =>
                                                    void chooseDriveFolder()
                                                }
                                            >
                                                <FolderOpen />
                                                {form.driveFolder
                                                    ? i18n("Change folder")
                                                    : i18n("Choose folder")}
                                            </Button>
                                        </div>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {i18n(
                                            "Riffado manages the folders it creates inside this folder. Do not keep your own files in them: a folder Riffado no longer needs goes to the Google Drive trash with everything in it. Google Docs are regenerated when the recording changes, so edits made in them are overwritten.",
                                        )}
                                    </p>
                                </div>
                            )}
                            {(
                                [
                                    ["exportAudio", i18n("Audio")],
                                    [
                                        "exportTranscript",
                                        i18n("Transcript (all variants)"),
                                    ],
                                    [
                                        "exportSummary",
                                        i18n("Summary (all variants)"),
                                    ],
                                ] as const
                            ).map(([key, label]) => (
                                <div
                                    key={key}
                                    className="space-y-3 rounded-md border p-3"
                                >
                                    <div className="flex items-center justify-between">
                                        <Label htmlFor={`folder-export-${key}`}>
                                            {label}
                                        </Label>
                                        <Switch
                                            id={`folder-export-${key}`}
                                            checked={form[key]}
                                            onCheckedChange={(checked) =>
                                                update({ [key]: checked })
                                            }
                                        />
                                    </div>
                                    {form.provider === "google-drive" &&
                                        key !== "exportAudio" &&
                                        form[key] && (
                                            <Select
                                                value={
                                                    key === "exportTranscript"
                                                        ? form.transcriptFormat
                                                        : form.summaryFormat
                                                }
                                                onValueChange={(value) =>
                                                    update(
                                                        key ===
                                                            "exportTranscript"
                                                            ? {
                                                                  transcriptFormat:
                                                                      value as DocumentFormat,
                                                              }
                                                            : {
                                                                  summaryFormat:
                                                                      value as DocumentFormat,
                                                              },
                                                    )
                                                }
                                            >
                                                <SelectTrigger
                                                    className="w-full"
                                                    aria-label={i18n(
                                                        "Format of {artifact}",
                                                        { artifact: label },
                                                    )}
                                                >
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {(
                                                        [
                                                            "google_doc",
                                                            "markdown",
                                                            "both",
                                                        ] as const
                                                    ).map((format) => (
                                                        <SelectItem
                                                            key={format}
                                                            value={format}
                                                        >
                                                            {formatLabel(
                                                                format,
                                                            )}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        )}
                                </div>
                            ))}
                            <DialogFooter>
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={saving}
                                    onClick={() => setForm(null)}
                                >
                                    {i18n("Cancel")}
                                </Button>
                                <Button
                                    type="button"
                                    disabled={!canSave}
                                    onClick={() => void save()}
                                >
                                    {saving
                                        ? i18n("Saving…")
                                        : i18n("Save export")}
                                </Button>
                            </DialogFooter>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {driveNeedsAttention && (
                                <div className="rounded-md border p-3">
                                    <GoogleConnectionPanel
                                        state={google.state}
                                        onChanged={() => void google.refresh()}
                                        returnTo={connectReturnTo("list")}
                                    />
                                </div>
                            )}
                            {configurations.map((configuration) => (
                                <div
                                    key={configuration.id}
                                    className="flex items-center gap-3 rounded-md border p-3"
                                >
                                    <button
                                        type="button"
                                        className="min-w-0 flex-1 text-left"
                                        onClick={() =>
                                            setForm(formFor(configuration))
                                        }
                                    >
                                        <span className="block truncate text-sm font-medium">
                                            {targetLabel(configuration)}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {artifactLabels(configuration)}
                                        </span>
                                        {configuration.lastError && (
                                            <span className="block text-xs text-destructive">
                                                {configuration.lastError}
                                            </span>
                                        )}
                                    </button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={i18n(
                                            "Remove export {path}",
                                            {
                                                path: targetLabel(
                                                    configuration,
                                                ),
                                            },
                                        )}
                                        onClick={() =>
                                            void remove(configuration.id)
                                        }
                                    >
                                        <Trash2 />
                                    </Button>
                                </div>
                            ))}
                            {configurations.length === 0 && (
                                <p className="text-sm text-muted-foreground">
                                    {i18n(
                                        "No exports are configured directly on this folder.",
                                    )}
                                </p>
                            )}
                            <div className="flex flex-wrap gap-2">
                                {providers.filesystem && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() =>
                                            setForm(emptyForm("filesystem"))
                                        }
                                    >
                                        <Plus /> {i18n("Add filesystem export")}
                                    </Button>
                                )}
                                {providers.googleDrive && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() =>
                                            setForm(emptyForm("google-drive"))
                                        }
                                    >
                                        <Plus />{" "}
                                        {i18n("Add Google Drive export")}
                                    </Button>
                                )}
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
