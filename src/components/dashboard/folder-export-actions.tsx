"use client";

import { Plus, RefreshCw, Settings, Trash2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getApiErrorMessage } from "@/lib/api-errors";
import type { FolderExportConfigurationDto } from "@/lib/folder-exports/types";
import { followJob } from "@/lib/jobs/client";
import type { RecordingFolder } from "@/types/folder";

interface FolderExportActionsProps {
    folder: RecordingFolder;
    filesystemAvailable: boolean;
    privateTree: boolean;
}

interface FormState {
    id: string | null;
    targetPath: string;
    exportAudio: boolean;
    exportTranscript: boolean;
    exportSummary: boolean;
}

const EMPTY_FORM: FormState = {
    id: null,
    targetPath: "",
    exportAudio: true,
    exportTranscript: true,
    exportSummary: true,
};

export function FolderExportActions({
    folder,
    filesystemAvailable,
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

    const load = useCallback(async () => {
        if (!filesystemAvailable || !privateTree) {
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
    }, [filesystemAvailable, folder.id, privateTree]);

    useEffect(() => {
        void load();
    }, [load]);

    const save = async () => {
        if (!form) return;
        setSaving(true);
        const url = form.id
            ? `/api/folders/${folder.id}/exports/${form.id}`
            : `/api/folders/${folder.id}/exports`;
        try {
            const response = await fetch(url, {
                method: form.id ? "PATCH" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    provider: "filesystem",
                    targetPath: form.targetPath,
                    exportAudio: form.exportAudio,
                    exportTranscript: form.exportTranscript,
                    exportSummary: form.exportSummary,
                }),
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
                    {!filesystemAvailable ? (
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Filesystem export requires a self-hosted deployment with FILESYSTEM_EXPORT_ROOT configured.",
                            )}
                        </p>
                    ) : !privateTree ? (
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Filesystem exports can only be configured for Private folders.",
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
                                    value="Filesystem"
                                    disabled
                                />
                            </div>
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
                                        setForm((current) =>
                                            current
                                                ? {
                                                      ...current,
                                                      targetPath:
                                                          event.target.value,
                                                  }
                                                : current,
                                        )
                                    }
                                />
                            </div>
                            {(
                                [
                                    ["exportAudio", "Audio"],
                                    [
                                        "exportTranscript",
                                        "Transcript (all variants)",
                                    ],
                                    ["exportSummary", "Summary (all variants)"],
                                ] as const
                            ).map(([key, label]) => (
                                <div
                                    key={key}
                                    className="flex items-center justify-between rounded-md border p-3"
                                >
                                    <Label htmlFor={`folder-export-${key}`}>
                                        {label}
                                    </Label>
                                    <Switch
                                        id={`folder-export-${key}`}
                                        checked={form[key]}
                                        onCheckedChange={(checked) =>
                                            setForm((current) =>
                                                current
                                                    ? {
                                                          ...current,
                                                          [key]: checked,
                                                      }
                                                    : current,
                                            )
                                        }
                                    />
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
                                    disabled={
                                        saving ||
                                        !form.targetPath.trim() ||
                                        (!form.exportAudio &&
                                            !form.exportTranscript &&
                                            !form.exportSummary)
                                    }
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
                            {configurations.map((configuration) => (
                                <div
                                    key={configuration.id}
                                    className="flex items-center gap-3 rounded-md border p-3"
                                >
                                    <button
                                        type="button"
                                        className="min-w-0 flex-1 text-left"
                                        onClick={() =>
                                            setForm({
                                                id: configuration.id,
                                                targetPath:
                                                    configuration.targetPath,
                                                exportAudio:
                                                    configuration.exportAudio,
                                                exportTranscript:
                                                    configuration.exportTranscript,
                                                exportSummary:
                                                    configuration.exportSummary,
                                            })
                                        }
                                    >
                                        <span className="block truncate text-sm font-medium">
                                            {configuration.targetPath}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {[
                                                configuration.exportAudio &&
                                                    "Audio",
                                                configuration.exportTranscript &&
                                                    "Transcript",
                                                configuration.exportSummary &&
                                                    "Summary",
                                            ]
                                                .filter(Boolean)
                                                .join(", ")}
                                        </span>
                                    </button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={i18n(
                                            "Remove export {path}",
                                            { path: configuration.targetPath },
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
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setForm(EMPTY_FORM)}
                            >
                                <Plus /> {i18n("Add filesystem export")}
                            </Button>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
