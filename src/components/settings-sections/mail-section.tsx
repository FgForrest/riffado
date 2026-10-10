"use client";

import {
    Copy,
    KeyRound,
    Mail,
    Pencil,
    Plus,
    RefreshCw,
    ShieldAlert,
    Trash2,
} from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { ToggleRow } from "@/components/settings/toggle-row";
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
import { getApiErrorMessage } from "@/lib/api-errors";
import { formatDateTime } from "@/lib/format-date";
import type {
    DeliveryLogEntry,
    MailAddressView,
    MailSettingsView,
} from "@/lib/mail/views";

async function copyAddress(
    address: string,
    i18n: ReturnType<typeof useExtracted>,
): Promise<void> {
    try {
        await navigator.clipboard.writeText(address);
        toast.success(i18n("Address copied"));
    } catch {
        toast.error(i18n("Could not copy the address"));
    }
}

function AddressLine({
    address,
    detail,
    actions,
}: {
    address: string;
    detail?: string | null;
    actions?: React.ReactNode;
}) {
    const i18n = useExtracted();
    return (
        <div className="flex items-center justify-between gap-3 py-1.5">
            <div className="min-w-0">
                <div className="truncate font-mono text-sm">{address}</div>
                {detail && (
                    <div className="truncate text-xs text-muted-foreground">
                        {detail}
                    </div>
                )}
            </div>
            <div className="flex shrink-0 gap-1">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={i18n("Copy {address}", { address })}
                    onClick={() => void copyAddress(address, i18n)}
                >
                    <Copy className="size-4" />
                </Button>
                {actions}
            </div>
        </div>
    );
}

/**
 * Settings -> Mail: the addresses that file mail into the viewer's pile,
 * the secret ones for mail they do not send themselves, what became of
 * recent mail, and how to send it.
 */
export function MailSection() {
    const i18n = useExtracted();
    const locale = useLocale();
    const confirm = useConfirm();
    const [view, setView] = useState<MailSettingsView | null>(null);
    const [log, setLog] = useState<DeliveryLogEntry[]>([]);
    const [failed, setFailed] = useState(false);
    const [autoProcess, setAutoProcess] = useState(true);
    const [creating, setCreating] = useState(false);
    const [baseId, setBaseId] = useState("");
    const [label, setLabel] = useState("");
    const [saving, setSaving] = useState(false);
    const [labelling, setLabelling] = useState<MailAddressView | null>(null);

    const load = useCallback(async () => {
        try {
            const [addresses, deliveries, settings] = await Promise.all([
                fetch("/api/mail/addresses"),
                fetch("/api/mail/delivery-log"),
                fetch("/api/settings/user"),
            ]);
            if (!addresses.ok || !deliveries.ok) {
                throw new Error("Failed to load mail settings");
            }
            setView((await addresses.json()) as MailSettingsView);
            setLog(
                ((await deliveries.json()) as { entries: DeliveryLogEntry[] })
                    .entries,
            );
            if (settings.ok) {
                const data = (await settings.json()) as {
                    mailAutoProcess?: boolean;
                };
                setAutoProcess(data.mailAutoProcess ?? true);
            }
        } catch {
            setFailed(true);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const changeAutoProcess = async (checked: boolean) => {
        setAutoProcess(checked);
        const response = await fetch("/api/settings/user", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mailAutoProcess: checked }),
        }).catch(() => null);
        if (!response?.ok) {
            setAutoProcess(!checked);
            toast.error(i18n("Could not save the setting"));
        }
    };

    const addresses = view?.addresses ?? [];
    const mailbox = addresses.find((address) => address.kind === "mailbox");
    const folderAddresses = addresses.filter(
        (address) => address.kind === "folder",
    );
    const secrets = addresses.filter((address) => address.kind === "secret");
    const bases = addresses.filter(
        (address) =>
            address.kind === "mailbox" ||
            (address.kind === "folder" && address.primary),
    );
    const addressById = new Map(
        addresses.map((address) => [address.id, address]),
    );

    const lastReceived = (address: MailAddressView): string =>
        address.lastReceivedAt
            ? i18n("Last mail {when}", {
                  when: formatDateTime(
                      address.lastReceivedAt,
                      "relative",
                      locale,
                  ),
              })
            : i18n("No mail yet");

    const createSecret = async () => {
        if (!baseId) return;
        setSaving(true);
        try {
            const response = await fetch("/api/mail/addresses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    baseAddressId: baseId,
                    label: label.trim() || null,
                }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not create the address"),
                    ),
                );
                return;
            }
            const { address } = (await response.json()) as {
                address: MailAddressView;
            };
            setCreating(false);
            setLabel("");
            toast.success(i18n("Secret address created"));
            void copyAddress(address.address, i18n);
            await load();
        } finally {
            setSaving(false);
        }
    };

    const saveLabel = async () => {
        if (!labelling) return;
        setSaving(true);
        try {
            const response = await fetch(
                `/api/mail/addresses/${encodeURIComponent(labelling.id)}`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ label: label.trim() || null }),
                },
            );
            if (!response.ok) {
                toast.error(i18n("Could not rename the address"));
                return;
            }
            setLabelling(null);
            await load();
        } finally {
            setSaving(false);
        }
    };

    const rotate = (address: MailAddressView) => {
        void confirm({
            title: i18n("Replace this secret address?"),
            description: i18n(
                "A new address takes its place, for the same target and name. The old one stops working at once and for good: update the Gmail filter or whoever uses it.",
            ),
            confirmLabel: i18n("Replace"),
            pendingLabel: i18n("Replacing…"),
            onConfirm: async () => {
                const response = await fetch(
                    `/api/mail/addresses/${encodeURIComponent(address.id)}/rotate`,
                    { method: "POST" },
                );
                if (!response.ok) throw new Error("rotate failed");
                const { address: replaced } = (await response.json()) as {
                    address: MailAddressView;
                };
                void copyAddress(replaced.address, i18n);
                await load();
            },
            errorMessage: i18n("Could not replace the address"),
        });
    };

    const revoke = (address: MailAddressView) => {
        void confirm({
            title: i18n("Stop this address?"),
            description: i18n(
                "{address} stops receiving mail for good. Nobody can be given it again.",
                { address: address.address },
            ),
            confirmLabel: i18n("Stop address"),
            pendingLabel: i18n("Stopping…"),
            destructive: true,
            onConfirm: async () => {
                const response = await fetch(
                    `/api/mail/addresses/${encodeURIComponent(address.id)}`,
                    { method: "DELETE" },
                );
                if (!response.ok) throw new Error("revoke failed");
                await load();
            },
            errorMessage: i18n("Could not stop the address"),
        });
    };

    const outcomeText = (entry: DeliveryLogEntry): string => {
        if (entry.outcome === "accepted") return i18n("Received");
        if (entry.outcome === "duplicate") return i18n("Already received");
        switch (entry.reason) {
            case "unknown_address":
                return i18n("Refused: no such address");
            case "address_inactive":
                return i18n("Refused: the address is stopped");
            case "from_header":
                return i18n("Refused: unclear sender");
            case "not_signed":
                return i18n("Refused: not signed by the sender's domain");
            case "signature_untimed":
            case "signature_stale":
                return i18n("Refused: the signature is too old");
            case "sender_mismatch":
                return i18n("Refused: sent by someone else");
            case "owner_inactive":
                return i18n("Refused: the address is paused");
            case "not_addressed":
                return i18n(
                    "Refused: an Organization address must be in To or Cc",
                );
            case "not_a_user":
                return i18n("Refused: the sender is not a user here");
            default:
                return i18n("Refused");
        }
    };

    return (
        <div className="space-y-6">
            <SettingsSectionHeader
                title={i18n("Mail")}
                description={i18n(
                    "Mail sent, forwarded or copied to these addresses lands in your Chatter pile, encrypted, next to your recordings.",
                )}
                icon={Mail}
            />

            {failed && (
                <p className="text-sm text-destructive">
                    {i18n("Mail settings could not be loaded.")}
                </p>
            )}
            {!view && !failed && (
                <div className="flex items-center justify-center py-8">
                    <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
            )}

            {view && !view.eligible && (
                <SettingsCard>
                    <p className="text-sm text-muted-foreground">
                        {i18n(
                            "Mail needs single sign-on: sign in with your organization's account to get addresses.",
                        )}
                    </p>
                </SettingsCard>
            )}

            {view?.eligible && (
                <>
                    {!view.receiving && (
                        <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                            {i18n(
                                "Your addresses are paused because you have not signed in with single sign-on for a long time. Sign in that way to resume them.",
                            )}
                        </div>
                    )}

                    <SettingsCard
                        title={i18n("Your addresses")}
                        description={i18n(
                            "Only mail you send yourself, from the account you sign in with, is accepted here.",
                        )}
                    >
                        {mailbox && (
                            <AddressLine
                                address={mailbox.address}
                                detail={`${i18n("Your pile, unfiled")} · ${lastReceived(mailbox)}`}
                            />
                        )}
                        {folderAddresses.map((address) => (
                            <AddressLine
                                key={address.id}
                                address={address.address}
                                detail={`${
                                    address.primary
                                        ? (address.folderName ??
                                          i18n("A folder"))
                                        : i18n("Old address of {folder}", {
                                              folder:
                                                  address.folderName ??
                                                  i18n("a folder"),
                                          })
                                } · ${lastReceived(address)}`}
                                actions={
                                    address.primary ? undefined : (
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={i18n("Stop {address}", {
                                                address: address.address,
                                            })}
                                            onClick={() => revoke(address)}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    )
                                }
                            />
                        ))}
                        <p className="pt-2 text-xs text-muted-foreground">
                            {i18n(
                                "Every folder has its own address; change it in the folder's header. Organization folders' addresses (they start with the organization's name) work in To or Cc only, and the mail waits in your pile until you share it.",
                            )}
                        </p>
                    </SettingsCard>

                    <SettingsCard
                        title={i18n("Secret addresses")}
                        description={i18n(
                            "For mail you do not send yourself: a Gmail filter, automatic forwarding, a newsletter. Anyone who knows a secret address can send to it, so replace or stop it when it leaks.",
                        )}
                        icon={KeyRound}
                        action={
                            <Button
                                size="sm"
                                disabled={bases.length === 0}
                                onClick={() => {
                                    setBaseId(
                                        mailbox?.id ?? bases[0]?.id ?? "",
                                    );
                                    setLabel("");
                                    setCreating(true);
                                }}
                            >
                                <Plus className="size-4" /> {i18n("New")}
                            </Button>
                        }
                    >
                        {secrets.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                {i18n("No secret addresses yet.")}
                            </p>
                        ) : (
                            secrets.map((address) => {
                                const base = address.baseAddressId
                                    ? addressById.get(address.baseAddressId)
                                    : undefined;
                                return (
                                    <AddressLine
                                        key={address.id}
                                        address={address.address}
                                        detail={[
                                            address.label,
                                            base?.kind === "folder"
                                                ? (base.folderName ??
                                                  base.address)
                                                : i18n("Your pile, unfiled"),
                                            lastReceived(address),
                                        ]
                                            .filter(Boolean)
                                            .join(" · ")}
                                        actions={
                                            <>
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    aria-label={i18n(
                                                        "Rename {address}",
                                                        {
                                                            address:
                                                                address.address,
                                                        },
                                                    )}
                                                    onClick={() => {
                                                        setLabel(
                                                            address.label ?? "",
                                                        );
                                                        setLabelling(address);
                                                    }}
                                                >
                                                    <Pencil className="size-4" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    aria-label={i18n(
                                                        "Replace {address}",
                                                        {
                                                            address:
                                                                address.address,
                                                        },
                                                    )}
                                                    onClick={() =>
                                                        rotate(address)
                                                    }
                                                >
                                                    <RefreshCw className="size-4" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    aria-label={i18n(
                                                        "Stop {address}",
                                                        {
                                                            address:
                                                                address.address,
                                                        },
                                                    )}
                                                    onClick={() =>
                                                        revoke(address)
                                                    }
                                                >
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </>
                                        }
                                    />
                                );
                            })
                        )}
                    </SettingsCard>

                    <SettingsCard title={i18n("Processing")}>
                        <ToggleRow
                            id="mail-auto-process"
                            label={i18n("Process mail automatically")}
                            description={i18n(
                                "Summarize new mail and learn from it as recordings are. Mail sent by machines (auto-replies, lists, notices) is kept but never processed.",
                            )}
                            checked={autoProcess}
                            onCheckedChange={(checked) =>
                                void changeAutoProcess(checked)
                            }
                        />
                    </SettingsCard>

                    <SettingsCard title={i18n("How to send mail here")}>
                        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
                            <li>
                                {i18n(
                                    "Forward a mail, or put your address in To, Cc or Bcc, from the account you sign in with. Mail from anyone else to these addresses is refused and listed below.",
                                )}
                            </li>
                            <li>
                                {i18n(
                                    "To file it straight into a folder, use the folder's address.",
                                )}
                            </li>
                            <li>
                                {i18n(
                                    "Automatic forwarding keeps the original sender, so it needs a secret address. In Gmail: Settings, Forwarding and POP/IMAP, Add a forwarding address, and enter a secret address. Gmail sends a confirmation code there: it arrives in your Chatter pile as a mail from Google. Open it, enter the code in Gmail, then create a filter that forwards to that address.",
                                )}
                            </li>
                        </ul>
                    </SettingsCard>

                    <SettingsCard
                        title={i18n("Delivery log")}
                        description={i18n(
                            "What became of mail sent to your addresses in the last 30 days.",
                        )}
                    >
                        {log.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                {i18n("Nothing yet.")}
                            </p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-xs">
                                    <thead className="text-muted-foreground">
                                        <tr>
                                            <th className="py-1 pr-3 font-medium">
                                                {i18n("When")}
                                            </th>
                                            <th className="py-1 pr-3 font-medium">
                                                {i18n("To")}
                                            </th>
                                            <th className="py-1 pr-3 font-medium">
                                                {i18n("From domain")}
                                            </th>
                                            <th className="py-1 font-medium">
                                                {i18n("Result")}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                        {log.map((entry) => (
                                            <tr key={entry.id}>
                                                <td className="py-1.5 pr-3 whitespace-nowrap">
                                                    {formatDateTime(
                                                        entry.at,
                                                        "absolute",
                                                        locale,
                                                    )}
                                                </td>
                                                <td className="py-1.5 pr-3 font-mono">
                                                    {entry.address ?? "—"}
                                                </td>
                                                <td className="py-1.5 pr-3">
                                                    {entry.senderDomain ?? "—"}
                                                </td>
                                                <td className="py-1.5">
                                                    {entry.itemId ? (
                                                        <a
                                                            href={`/dashboard?recording=${encodeURIComponent(entry.itemId)}`}
                                                            className="text-primary hover:underline"
                                                        >
                                                            {outcomeText(entry)}
                                                        </a>
                                                    ) : (
                                                        outcomeText(entry)
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </SettingsCard>
                </>
            )}

            <Dialog open={creating} onOpenChange={setCreating}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{i18n("New secret address")}</DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "Mail to it lands where the address it extends files mail, from any sender.",
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="space-y-1.5">
                            <Label htmlFor="mail-secret-base">
                                {i18n("Files mail like")}
                            </Label>
                            <Select value={baseId} onValueChange={setBaseId}>
                                <SelectTrigger id="mail-secret-base">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {bases.map((base) => (
                                        <SelectItem
                                            key={base.id}
                                            value={base.id}
                                        >
                                            {base.address}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="mail-secret-label">
                                {i18n("Name (only you see it)")}
                            </Label>
                            <Input
                                id="mail-secret-label"
                                value={label}
                                maxLength={100}
                                placeholder={i18n("Gmail filter")}
                                onChange={(event) =>
                                    setLabel(event.target.value)
                                }
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => setCreating(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            disabled={saving || !baseId}
                            onClick={() => void createSecret()}
                        >
                            {i18n("Create")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                open={labelling !== null}
                onOpenChange={(open) => {
                    if (!open) setLabelling(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {i18n("Rename secret address")}
                        </DialogTitle>
                        <DialogDescription>
                            {labelling?.address}
                        </DialogDescription>
                    </DialogHeader>
                    <Input
                        value={label}
                        maxLength={100}
                        aria-label={i18n("Name (only you see it)")}
                        onChange={(event) => setLabel(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                void saveLabel();
                            }
                        }}
                    />
                    <DialogFooter>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => setLabelling(null)}
                        >
                            {i18n("Cancel")}
                        </Button>
                        <Button
                            disabled={saving}
                            onClick={() => void saveLabel()}
                        >
                            {i18n("Save")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
