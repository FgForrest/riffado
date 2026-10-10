"use client";

import {
    ArrowLeft,
    BadgeCheck,
    Download,
    FileCode2,
    Loader2,
    Paperclip,
    Share2,
    ShieldAlert,
    Trash2,
} from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatBytes } from "@/lib/format-bytes";
import { formatDateTime } from "@/lib/format-date";
import type { MailDetail, MailParticipantView } from "@/lib/mail/detail";
import { cn } from "@/lib/utils";
import type { DateTimeFormat } from "@/types/common";
import type { Recording } from "@/types/recording";

interface Props {
    mail: Recording;
    dateTimeFormat: DateTimeFormat;
    onBackToList: () => void;
    hiddenOnMobile: boolean;
    /** The mail was deleted or shared: reload the pile. */
    onChanged: () => void;
}

function person(participant: MailParticipantView): string {
    if (participant.name && participant.address) {
        return `${participant.name} <${participant.address}>`;
    }
    return participant.name ?? participant.address ?? "";
}

function withRole(
    participants: readonly MailParticipantView[],
    role: string,
): MailParticipantView[] {
    return participants.filter((participant) =>
        participant.roles.includes(role),
    );
}

/**
 * A mail in the Chatter pile: who it is from and to, its own text, its
 * signature, the quoted and forwarded messages (folded), attachments as
 * downloads only, and, on request, its formatted HTML in a sandboxed frame
 * that can run nothing and fetch nothing.
 */
export function MailDetailPane({
    mail,
    dateTimeFormat,
    onBackToList,
    hiddenOnMobile,
    onChanged,
}: Props) {
    const i18n = useExtracted();
    const locale = useLocale();
    const confirm = useConfirm();
    const [detail, setDetail] = useState<MailDetail | null>(null);
    const [failed, setFailed] = useState(false);
    const [formatted, setFormatted] = useState<string | null>(null);
    const [showFormatted, setShowFormatted] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        setDetail(null);
        setFailed(false);
        setFormatted(null);
        setShowFormatted(false);
        fetch(`/api/mail/${encodeURIComponent(mail.id)}`, {
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) throw new Error(String(response.status));
                setDetail((await response.json()) as MailDetail);
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) {
                    console.error("[mail] could not load the mail:", error);
                    setFailed(true);
                }
            });
        return () => controller.abort();
    }, [mail.id]);

    const toggleFormatted = useCallback(async () => {
        if (showFormatted) {
            setShowFormatted(false);
            return;
        }
        if (formatted === null) {
            const response = await fetch(
                `/api/mail/${encodeURIComponent(mail.id)}/html`,
            );
            const body = (await response.json().catch(() => ({}))) as {
                html?: string | null;
            };
            if (!response.ok || !body.html) {
                toast.error(i18n("This mail has no formatted version."));
                return;
            }
            setFormatted(body.html);
        }
        setShowFormatted(true);
    }, [formatted, i18n, mail.id, showFormatted]);

    const share = useCallback(
        async (folderId: string, action: "share" | "dismiss") => {
            setBusy(folderId);
            try {
                const response = await fetch(
                    `/api/mail/${encodeURIComponent(mail.id)}/share`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ folderId, action }),
                    },
                );
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as {
                        error?: string;
                    };
                    toast.error(
                        body.error ?? i18n("The mail could not be shared."),
                    );
                    return;
                }
                setDetail((previous) =>
                    previous
                        ? {
                              ...previous,
                              pendingShares: previous.pendingShares.filter(
                                  (pending) => pending.folderId !== folderId,
                              ),
                          }
                        : previous,
                );
                toast.success(
                    action === "share"
                        ? i18n("Shared with the Organization.")
                        : i18n("Kept in your pile only."),
                );
                onChanged();
            } finally {
                setBusy(null);
            }
        },
        [i18n, mail.id, onChanged],
    );

    const remove = useCallback(() => {
        void confirm({
            title: i18n("Delete this mail?"),
            description: i18n(
                "The message, its attachments and anything made from it are removed for good.",
            ),
            confirmLabel: i18n("Delete"),
            pendingLabel: i18n("Deleting…"),
            destructive: true,
            onConfirm: async () => {
                const response = await fetch(
                    `/api/mail/${encodeURIComponent(mail.id)}`,
                    { method: "DELETE" },
                );
                if (!response.ok) {
                    toast.error(i18n("The mail could not be deleted."));
                    return;
                }
                toast.success(i18n("Mail deleted."));
                onChanged();
            },
        });
    }, [confirm, i18n, mail.id, onChanged]);

    const from = detail ? withRole(detail.participants, "from")[0] : undefined;
    const sender = detail
        ? withRole(detail.participants, "sender")[0]
        : undefined;
    const to = detail ? withRole(detail.participants, "to") : [];
    const cc = detail ? withRole(detail.participants, "cc") : [];
    const byRef = new Map(
        (detail?.participants ?? []).map((participant) => [
            participant.ref,
            participant,
        ]),
    );

    return (
        <div
            className={cn(
                "space-y-4 lg:col-span-2 lg:block lg:self-start",
                hiddenOnMobile && "hidden",
            )}
        >
            <Button
                variant="ghost"
                size="sm"
                onClick={onBackToList}
                className="-ml-2 h-9 gap-1 px-2 lg:hidden"
            >
                <ArrowLeft className="size-4" /> {i18n("Back to the pile")}
            </Button>
            <Card>
                <CardContent className="space-y-4 p-4 sm:p-6">
                    <div className="flex items-start justify-between gap-3">
                        <h2 className="text-lg font-semibold break-words">
                            {mail.filename || i18n("(no subject)")}
                        </h2>
                        <div className="flex shrink-0 gap-1">
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={i18n("Download the message")}
                                asChild
                            >
                                <a
                                    href={`/api/mail/${encodeURIComponent(mail.id)}/raw`}
                                    download
                                >
                                    <Download className="size-4" />
                                </a>
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={i18n("Delete")}
                                onClick={remove}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </div>
                    </div>
                    {failed && (
                        <p className="text-sm text-destructive">
                            {i18n("The mail could not be loaded.")}
                        </p>
                    )}
                    {!detail && !failed && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="size-4 animate-spin" />
                            {i18n("Loading…")}
                        </div>
                    )}
                    {detail && (
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                            <dt className="text-muted-foreground">
                                {i18n("From")}
                            </dt>
                            <dd className="flex flex-wrap items-center gap-1.5 break-all">
                                {from ? person(from) : "—"}
                                {detail.senderVerified ? (
                                    <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                                        <BadgeCheck className="size-3.5" />
                                        {i18n("Verified")}
                                    </span>
                                ) : (
                                    <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                                        <ShieldAlert className="size-3.5" />
                                        {i18n("Sender not verified")}
                                    </span>
                                )}
                            </dd>
                            {sender && (
                                <>
                                    <dt className="text-muted-foreground">
                                        {i18n("Sent by")}
                                    </dt>
                                    <dd className="break-all">
                                        {person(sender)}
                                    </dd>
                                </>
                            )}
                            {to.length > 0 && (
                                <>
                                    <dt className="text-muted-foreground">
                                        {i18n("To")}
                                    </dt>
                                    <dd className="break-all">
                                        {to.map(person).join(", ")}
                                    </dd>
                                </>
                            )}
                            {cc.length > 0 && (
                                <>
                                    <dt className="text-muted-foreground">
                                        {i18n("Cc")}
                                    </dt>
                                    <dd className="break-all">
                                        {cc.map(person).join(", ")}
                                    </dd>
                                </>
                            )}
                            <dt className="text-muted-foreground">
                                {i18n("Date")}
                            </dt>
                            <dd>
                                {formatDateTime(
                                    detail.sentAt ?? detail.receivedAt,
                                    dateTimeFormat,
                                    locale,
                                )}
                            </dd>
                        </dl>
                    )}
                    {detail?.pendingShares.map((pending) => (
                        <div
                            key={pending.folderId}
                            className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
                        >
                            <Share2 className="size-4 text-primary" />
                            <span className="flex-1">
                                {i18n(
                                    "Sent to {folder}: waiting for your review before it joins the Organization folder.",
                                    { folder: pending.name },
                                )}
                            </span>
                            <Button
                                size="sm"
                                disabled={busy !== null}
                                onClick={() =>
                                    void share(pending.folderId, "share")
                                }
                            >
                                {i18n("Share")}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy !== null}
                                onClick={() =>
                                    void share(pending.folderId, "dismiss")
                                }
                            >
                                {i18n("Keep private")}
                            </Button>
                        </div>
                    ))}
                    {detail?.autoGenerated && (
                        <p className="text-xs text-muted-foreground">
                            {i18n(
                                "Sent by a machine (an auto-reply, a list, a notice): kept, never summarized.",
                            )}
                        </p>
                    )}
                    {detail?.unreadable && (
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "This mail's content is not readable here (encrypted or packed). Download the message to open it.",
                            )}
                        </p>
                    )}
                </CardContent>
            </Card>

            {detail && detail.segments.length > 0 && (
                <Card>
                    <CardContent className="space-y-3 p-4 sm:p-6">
                        <div className="flex justify-end">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1 px-2 text-xs"
                                onClick={() => void toggleFormatted()}
                            >
                                <FileCode2 className="size-3.5" />
                                {showFormatted
                                    ? i18n("Show text")
                                    : i18n("Show formatted")}
                            </Button>
                        </div>
                        {showFormatted && formatted ? (
                            <iframe
                                title={i18n("Formatted mail")}
                                sandbox=""
                                srcDoc={formatted}
                                referrerPolicy="no-referrer"
                                className="h-[70vh] w-full rounded border bg-white"
                            />
                        ) : (
                            detail.segments.map((segment) => {
                                const author = segment.participantRef
                                    ? byRef.get(segment.participantRef)
                                    : undefined;
                                const text = (
                                    <p className="whitespace-pre-wrap break-words text-sm">
                                        {segment.text}
                                    </p>
                                );
                                if (segment.role === "body") {
                                    return (
                                        <div key={segment.index}>{text}</div>
                                    );
                                }
                                if (segment.role === "signature") {
                                    return (
                                        <div
                                            key={segment.index}
                                            className="border-l-2 pl-3 text-muted-foreground [&_p]:text-xs"
                                        >
                                            {text}
                                        </div>
                                    );
                                }
                                const label =
                                    segment.role === "disclaimer"
                                        ? i18n("Disclaimer")
                                        : segment.role === "quoted_signature"
                                          ? i18n("Signature of {name}", {
                                                name: author
                                                    ? person(author)
                                                    : i18n("the quoted sender"),
                                            })
                                          : i18n("Quoted from {name}", {
                                                name: author
                                                    ? person(author)
                                                    : i18n(
                                                          "an earlier message",
                                                      ),
                                            });
                                return (
                                    <details
                                        key={segment.index}
                                        className="rounded border bg-muted/30 px-3 py-2"
                                        style={{
                                            marginLeft: `${Math.max(0, segment.depth - 1) * 12}px`,
                                        }}
                                    >
                                        <summary className="cursor-pointer text-xs text-muted-foreground">
                                            {label}
                                            {segment.at &&
                                                ` · ${formatDateTime(segment.at, dateTimeFormat, locale)}`}
                                        </summary>
                                        <div className="mt-2">{text}</div>
                                    </details>
                                );
                            })
                        )}
                    </CardContent>
                </Card>
            )}

            {detail && detail.attachments.length > 0 && (
                <Card>
                    <CardContent className="space-y-2 p-4 sm:p-6">
                        <h3 className="flex items-center gap-1.5 text-sm font-medium">
                            <Paperclip className="size-4" />
                            {i18n("Attachments")}
                        </h3>
                        <ul className="space-y-1 text-sm">
                            {detail.attachments.map((attachment) => (
                                <li key={attachment.index}>
                                    <a
                                        href={`/api/mail/${encodeURIComponent(mail.id)}/attachments/${attachment.index}`}
                                        download
                                        className="text-primary hover:underline"
                                    >
                                        {attachment.filename ??
                                            i18n("Attachment {n}", {
                                                n: String(attachment.index + 1),
                                            })}
                                    </a>{" "}
                                    <span className="text-xs text-muted-foreground">
                                        {formatBytes(attachment.size)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
