"use client";

import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsCard } from "@/components/settings/settings-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const MAIL_KINDS = [
    { key: "raw", setting: "retentionMailRawDays" },
    { key: "content", setting: "retentionMailContentDays" },
    { key: "summary", setting: "retentionMailSummaryDays" },
] as const;

type MailKey = (typeof MAIL_KINDS)[number]["key"];
type MailSetting = (typeof MAIL_KINDS)[number]["setting"];
type MailPolicy = Record<MailKey, { enabled: boolean; days: number }>;

const DEFAULT_POLICY: MailPolicy = {
    raw: { enabled: false, days: 90 },
    content: { enabled: false, days: 90 },
    summary: { enabled: false, days: 90 },
};

/** The stored mail policy in `settings`, off where it holds none. */
export function readMailRetention(
    settings: Record<string, unknown>,
): MailPolicy {
    const policy = structuredClone(DEFAULT_POLICY);
    for (const item of MAIL_KINDS) {
        const value = settings[item.setting];
        if (
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= 1 &&
            value <= 365
        ) {
            policy[item.key] = { enabled: true, days: value };
        }
    }
    return policy;
}

function payloadOf(policy: MailPolicy): Record<MailSetting, number | null> {
    return Object.fromEntries(
        MAIL_KINDS.map((item) => [
            item.setting,
            policy[item.key].enabled ? policy[item.key].days : null,
        ]),
    ) as Record<MailSetting, number | null>;
}

function save(policy: MailPolicy): Promise<Response> {
    return fetch("/api/settings/user", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadOf(policy)),
    });
}

/**
 * Mail's own auto-delete: a period per part, counted from when a mail
 * arrived, with how many mails it would touch today before it is saved.
 */
export function MailRetentionCard({ initial }: { initial: MailPolicy }) {
    const i18n = useExtracted();
    const copy = {
        raw: {
            label: i18n("Mail as it arrived"),
            hint: i18n(
                "The stored message with its attachments. Its text, summary and tasks stay unless they go below.",
            ),
        },
        content: {
            label: i18n("Mail text"),
            hint: i18n(
                "The text Riffado read. Facts learned only from it go with it; who wrote to whom stays.",
            ),
        },
        summary: {
            label: i18n("Mail summary"),
            hint: i18n("Summary, key points and the tasks proposed from it."),
        },
    } satisfies Record<MailKey, { label: string; hint: string }>;
    const [policy, setPolicy] = useState(initial);
    const persisted = useRef(initial);
    const pending = useRef<MailPolicy | undefined>(undefined);
    const timer = useRef<NodeJS.Timeout | undefined>(undefined);
    const [preview, setPreview] = useState<number | null>(null);

    const persist = async (next: MailPolicy) => {
        const response = await save(next).catch(() => null);
        if (response?.ok) {
            persisted.current = next;
            return;
        }
        setPolicy(persisted.current);
        toast.error(i18n("Failed to save settings. Changes reverted."));
    };

    // A period typed just before the dialog closes is still saved.
    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
            if (pending.current) void save(pending.current).catch(() => {});
        },
        [],
    );

    useEffect(() => {
        const payload = payloadOf(policy);
        if (Object.values(payload).every((days) => days === null)) {
            setPreview(null);
            return;
        }
        const params = new URLSearchParams();
        for (const item of MAIL_KINDS) {
            const days = payload[item.setting];
            if (days !== null) params.set(`${item.key}Days`, String(days));
        }
        const controller = new AbortController();
        const wait = setTimeout(() => {
            fetch(`/api/settings/retention/mail-preview?${params}`, {
                signal: controller.signal,
            })
                .then((response) => (response.ok ? response.json() : null))
                .then((data) => {
                    if (typeof data?.count === "number") setPreview(data.count);
                })
                .catch(() => {});
        }, 500);
        return () => {
            clearTimeout(wait);
            controller.abort();
        };
    }, [policy]);

    const setEnabled = (key: MailKey, enabled: boolean) => {
        if (timer.current) clearTimeout(timer.current);
        pending.current = undefined;
        const next = { ...policy, [key]: { ...policy[key], enabled } };
        setPolicy(next);
        void persist(next);
    };
    const setDays = (key: MailKey, days: number) => {
        const next = { ...policy, [key]: { ...policy[key], days } };
        setPolicy(next);
        if (timer.current) clearTimeout(timer.current);
        pending.current = next;
        timer.current = setTimeout(() => {
            pending.current = undefined;
            void persist(next);
        }, 500);
    };

    return (
        <SettingsCard
            title={i18n("Auto-delete old mail")}
            description={i18n(
                "Counted from when a mail arrived. Off keeps it. The mail stays in your pile with its sender and subject.",
            )}
        >
            <div className="divide-y rounded-lg border">
                {MAIL_KINDS.map(({ key }) => {
                    const value = policy[key];
                    return (
                        <div key={key} className="space-y-3 p-4">
                            <div className="flex items-start justify-between gap-4">
                                <div className="space-y-0.5">
                                    <Label
                                        htmlFor={`mail-retention-${key}`}
                                        className="text-sm font-normal"
                                    >
                                        {copy[key].label}
                                    </Label>
                                    <p className="text-xs text-muted-foreground">
                                        {copy[key].hint}
                                    </p>
                                </div>
                                <Switch
                                    id={`mail-retention-${key}`}
                                    checked={value.enabled}
                                    onCheckedChange={(checked) =>
                                        setEnabled(key, checked)
                                    }
                                />
                            </div>
                            <div className="flex items-center gap-2">
                                <Label
                                    htmlFor={`mail-retention-${key}-days`}
                                    className="text-xs text-muted-foreground"
                                >
                                    {i18n("Retention period")}
                                </Label>
                                <Input
                                    id={`mail-retention-${key}-days`}
                                    className="h-8 w-24"
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    max={365}
                                    step={1}
                                    value={value.days}
                                    disabled={!value.enabled}
                                    onChange={(event) => {
                                        const days = Number(event.target.value);
                                        if (
                                            Number.isInteger(days) &&
                                            days >= 1 &&
                                            days <= 365
                                        ) {
                                            setDays(key, days);
                                        }
                                    }}
                                />
                                <span className="text-xs text-muted-foreground">
                                    {i18n("days (1-365)")}
                                </span>
                            </div>
                        </div>
                    );
                })}
            </div>
            <p className="text-xs text-muted-foreground">
                {preview === null
                    ? i18n(
                          "When all options are off, mail is kept indefinitely.",
                      )
                    : preview === 0
                      ? i18n(
                            "No mail is old enough yet, so this deletes nothing today.",
                        )
                      : i18n(
                            "{count, plural, one {Applies to # mail right now.} other {Applies to # mails right now.}} The first sweep runs within the hour.",
                            { count: preview },
                        )}
            </p>
            <p className="text-xs text-muted-foreground">
                {i18n(
                    "While a mail is shared into the Organization, the Organization's policy applies to it instead. A message a folder export wrote stays there.",
                )}
            </p>
        </SettingsCard>
    );
}
