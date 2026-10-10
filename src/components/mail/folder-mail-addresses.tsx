"use client";

import { Copy, Loader2, Mail, Pencil, X } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
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
import { getApiErrorMessage } from "@/lib/api-errors";
import { formatDateTime } from "@/lib/format-date";
import type { MailAddressView } from "@/lib/mail/views";

interface FolderAddresses {
    writable: boolean;
    addresses: MailAddressView[];
}

async function fetchFolderAddresses(
    folderId: string,
    subtree: boolean,
    signal?: AbortSignal,
): Promise<FolderAddresses> {
    const response = await fetch(
        `/api/folders/${encodeURIComponent(folderId)}/mail-addresses${subtree ? "?subtree=1" : ""}`,
        { signal },
    );
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as FolderAddresses;
}

function useLastReceived() {
    const i18n = useExtracted();
    const locale = useLocale();
    return (address: MailAddressView) =>
        address.lastReceivedAt
            ? i18n("last mail {when}", {
                  when: formatDateTime(
                      address.lastReceivedAt,
                      "relative",
                      locale,
                  ),
              })
            : i18n("no mail yet");
}

/**
 * A folder's mail addresses in its header: the current one to copy or
 * change, and the old ones that still work until removed.
 */
export function FolderMailAddresses({ folderId }: { folderId: string }) {
    const i18n = useExtracted();
    const lastReceived = useLastReceived();
    const [data, setData] = useState<FolderAddresses | null>(null);
    const [editing, setEditing] = useState(false);
    const [alias, setAlias] = useState("");
    const [saving, setSaving] = useState(false);

    const load = useCallback(
        async (signal?: AbortSignal) => {
            try {
                setData(await fetchFolderAddresses(folderId, false, signal));
            } catch {
                if (!signal?.aborted) setData(null);
            }
        },
        [folderId],
    );

    useEffect(() => {
        const controller = new AbortController();
        setData(null);
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);

    const copy = async (address: string) => {
        try {
            await navigator.clipboard.writeText(address);
            toast.success(i18n("Address copied"));
        } catch {
            toast.error(i18n("Could not copy the address"));
        }
    };

    const save = async () => {
        if (!alias.trim()) return;
        setSaving(true);
        try {
            const response = await fetch(
                `/api/folders/${encodeURIComponent(folderId)}/mail-addresses`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ alias: alias.trim() }),
                },
            );
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not change the address"),
                    ),
                );
                return;
            }
            setEditing(false);
            await load();
        } finally {
            setSaving(false);
        }
    };

    const remove = async (address: MailAddressView) => {
        const response = await fetch(
            `/api/folders/${encodeURIComponent(folderId)}/mail-addresses/${encodeURIComponent(address.id)}`,
            { method: "DELETE" },
        );
        if (!response.ok) {
            toast.error(i18n("Could not remove the address"));
            return;
        }
        toast.success(
            i18n("{address} stopped for good", { address: address.address }),
        );
        await load();
    };

    const current = data?.addresses.find((address) => address.primary);
    const older = data?.addresses.filter((address) => !address.primary) ?? [];
    if (!current) return null;

    return (
        <div className="mt-2 space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                <Mail className="size-4 shrink-0" />
                <span className="font-mono text-foreground">
                    {current.address}
                </span>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={i18n("Copy {address}", {
                        address: current.address,
                    })}
                    onClick={() => void copy(current.address)}
                >
                    <Copy className="size-3.5" />
                </Button>
                {data?.writable && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={i18n("Change the folder's address")}
                        onClick={() => {
                            setAlias("");
                            setEditing(true);
                        }}
                    >
                        <Pencil className="size-3.5" />
                    </Button>
                )}
                <span className="text-xs">· {lastReceived(current)}</span>
            </div>
            {older.map((address) => (
                <div
                    key={address.id}
                    className="flex flex-wrap items-center gap-1.5 pl-5.5 text-xs text-muted-foreground"
                >
                    <span>{i18n("Also")}</span>
                    <span className="font-mono">{address.address}</span>
                    <span>· {lastReceived(address)}</span>
                    {data?.writable && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="size-6"
                            aria-label={i18n("Stop {address}", {
                                address: address.address,
                            })}
                            onClick={() => void remove(address)}
                        >
                            <X className="size-3.5" />
                        </Button>
                    )}
                </div>
            ))}

            <Dialog open={editing} onOpenChange={setEditing}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {i18n("Change the folder's address")}
                        </DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "Letters, digits and hyphens. {address} keeps working until you remove it.",
                                { address: current.address },
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <Input
                        value={alias}
                        maxLength={64}
                        placeholder={i18n("weekly")}
                        aria-label={i18n("New address")}
                        onChange={(event) => setAlias(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && alias.trim()) {
                                event.preventDefault();
                                void save();
                            }
                        }}
                    />
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={saving}
                            onClick={() => setEditing(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            type="button"
                            disabled={saving || !alias.trim()}
                            onClick={() => void save()}
                        >
                            {saving ? i18n("Saving…") : i18n("Save")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

/**
 * What deleting a folder stops (D9): every address of it and its
 * subfolders, with when each last received mail. Shown in the delete
 * confirmation; nothing when there are none.
 */
export function FolderDeletionAddresses({ folderId }: { folderId: string }) {
    const i18n = useExtracted();
    const lastReceived = useLastReceived();
    const [data, setData] = useState<FolderAddresses | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        fetchFolderAddresses(folderId, true, controller.signal)
            .then(setData)
            .catch(() => {
                if (!controller.signal.aborted) setFailed(true);
            });
        return () => controller.abort();
    }, [folderId]);

    if (failed) return null;
    if (!data) {
        return (
            <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {i18n("Checking the folder's mail addresses…")}
            </p>
        );
    }
    if (data.addresses.length === 0) return null;
    return (
        <div className="mt-3 space-y-1.5 text-sm">
            <p>
                {i18n(
                    "These mail addresses stop working for good, and nobody can be given them again:",
                )}
            </p>
            <ul className="space-y-0.5">
                {data.addresses.map((address) => (
                    <li key={address.id} className="text-xs">
                        <span className="font-mono">{address.address}</span>{" "}
                        <span className="text-muted-foreground">
                            · {lastReceived(address)}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
