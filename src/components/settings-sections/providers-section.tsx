"use client";

import { Bot, Pencil, Plus, Trash2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { AddProviderDialog } from "@/components/settings/add-provider-dialog";
import { EditProviderDialog } from "@/components/settings/edit-provider-dialog";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { Button } from "@/components/ui/button";
import {
    isEnhancementOnlyProvider,
    isTranscriptionOnlyProvider,
} from "@/lib/ai/provider-presets";

interface Provider {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
    createdAt: Date;
    managed?: boolean;
    includedSeconds?: number;
    available?: boolean;
}

const EMPTY_PROVIDERS: Provider[] = [];

interface ProvidersSectionProps {
    initialProviders?: Provider[];
    isHosted?: boolean;
}

/**
 * AI Providers settings section.
 *
 * The configured AI providers (transcription / enhancement) plus the
 * AddProviderDialog and EditProviderDialog. Local state seeded from
 * `initialProviders` and updated in place by the dialogs. Prompt templates
 * live with the features that use them: title templates in Transcription,
 * summary templates in Summary.
 *
 * Note: `initialProviders` is the server-rendered seed only. The local
 * `providers` state diverges from it after add/edit/delete actions; we do
 * NOT re-sync from the prop on changes (would clobber local edits). If the
 * parent ever needs to force a reset, pass a `key` prop instead.
 */
export function ProvidersSection({
    initialProviders = EMPTY_PROVIDERS,
    isHosted = false,
}: ProvidersSectionProps) {
    const i18n = useExtracted();
    const confirm = useConfirm();
    const [providers, setProviders] = useState<Provider[]>(initialProviders);
    /**
     * `initialProviders` can arrive *after* mount. The dashboard fetches
     * the list when the settings dialog opens (`workstation.tsx`), but
     * `<Dialog open>` mounts this section in that same render, so the seed
     * is `[]` for the first moment and `useState` ignores every later prop
     * value. That left the list permanently empty on a fresh page load --
     * until an add or delete replaced the state from a response, which is
     * why re-adding appeared to "find" the missing providers.
     *
     * So adopt the prop until this component starts managing the list
     * itself; from then on local state wins, which is the invariant the
     * note above is protecting.
     */
    const selfManaged = useRef(false);
    useEffect(() => {
        if (!selfManaged.current) setProviders(initialProviders);
    }, [initialProviders]);
    const [isAddProviderOpen, setIsAddProviderOpen] = useState(false);
    const [isEditProviderOpen, setIsEditProviderOpen] = useState(false);
    const [editingProvider, setEditingProvider] = useState<Provider | null>(
        null,
    );
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const refreshProviders = async () => {
        try {
            const response = await fetch("/api/settings/ai/providers");
            if (!response.ok) throw new Error("Failed to fetch");
            const data = (await response.json()) as { providers: Provider[] };
            selfManaged.current = true;
            setProviders(data.providers);
        } catch {
            toast.error(i18n("Failed to refresh providers"));
        }
    };

    const handleEdit = (provider: Provider) => {
        setEditingProvider(provider);
        setIsEditProviderOpen(true);
    };

    const handleSetDefaultTranscription = (providerId: string) => {
        void (async () => {
            try {
                const res = await fetch(
                    "/api/settings/ai/providers/default-transcription",
                    {
                        method: "PUT",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ providerId }),
                    },
                );
                if (!res.ok) {
                    const b = (await res.json().catch(() => ({}))) as {
                        error?: string;
                    };
                    throw new Error(b.error ?? `HTTP ${res.status}`);
                }
                toast.success(i18n("Default transcription provider updated"));
                await refreshProviders();
            } catch (e) {
                toast.error(
                    e instanceof Error
                        ? e.message
                        : i18n("Failed to update default"),
                );
            }
        })();
    };

    const handleSetDefaultEnhancement = (providerId: string) => {
        void (async () => {
            try {
                const res = await fetch(
                    "/api/settings/ai/providers/default-enhancement",
                    {
                        method: "PUT",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ providerId }),
                    },
                );
                if (!res.ok) {
                    const b = (await res.json().catch(() => ({}))) as {
                        error?: string;
                    };
                    throw new Error(b.error ?? `HTTP ${res.status}`);
                }
                toast.success(i18n("Default AI enhancement provider updated"));
                await refreshProviders();
            } catch (e) {
                toast.error(
                    e instanceof Error
                        ? e.message
                        : i18n("Failed to update default"),
                );
            }
        })();
    };

    const handleDelete = (id: string) => {
        void confirm({
            title: i18n("Delete this provider?"),
            description: i18n(
                "Its API key will be removed from this account. Recordings transcribed or summarized through it keep their data, but you'll need to re-add the provider to use it again.",
            ),
            confirmLabel: i18n("Delete"),
            pendingLabel: "Deleting…",
            destructive: true,
            onConfirm: async () => {
                setDeletingId(id);
                try {
                    const response = await fetch(
                        `/api/settings/ai/providers/${id}`,
                        { method: "DELETE" },
                    );
                    if (!response.ok) {
                        const error = (await response.json()) as {
                            error?: string;
                        };
                        throw new Error(error.error || "Failed to delete");
                    }
                    toast.success(i18n("Provider deleted successfully"));
                    await refreshProviders();
                } finally {
                    setDeletingId(null);
                }
            },
        });
    };

    return (
        <>
            <div className="space-y-6">
                <div className="flex items-center justify-between">
                    <SettingsSectionHeader
                        title={i18n("AI Providers")}
                        description={i18n(
                            "Connect transcription and summary providers. Anything OpenAI-compatible works.",
                        )}
                        icon={Bot}
                    />
                    <Button
                        onClick={() => setIsAddProviderOpen(true)}
                        size="sm"
                    >
                        <Plus className="size-4 mr-2" /> {i18n("Add Provider")}
                    </Button>
                </div>

                <ProvidersList
                    providers={providers}
                    deletingId={deletingId}
                    onAdd={() => setIsAddProviderOpen(true)}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onSetDefault={handleSetDefaultTranscription}
                    onSetDefaultEnhancement={handleSetDefaultEnhancement}
                />
            </div>

            <AddProviderDialog
                open={isAddProviderOpen}
                onOpenChange={setIsAddProviderOpen}
                isHosted={isHosted}
                onSuccess={() => {
                    setIsAddProviderOpen(false);
                    refreshProviders();
                }}
            />

            <EditProviderDialog
                open={isEditProviderOpen}
                onOpenChange={(open) => {
                    setIsEditProviderOpen(open);
                    if (!open) {
                        setEditingProvider(null);
                    }
                }}
                provider={editingProvider}
                isHosted={isHosted}
                onSuccess={() => {
                    setIsEditProviderOpen(false);
                    setEditingProvider(null);
                    refreshProviders();
                }}
            />
        </>
    );
}

/**
 * Configured-providers list with edit/delete row actions. Pure
 * presentation -- the parent owns the data + dialog state.
 */
function ProvidersList({
    providers,
    deletingId,
    onAdd,
    onEdit,
    onDelete,
    onSetDefault,
    onSetDefaultEnhancement,
}: {
    providers: Provider[];
    deletingId: string | null;
    onAdd: () => void;
    onEdit: (provider: Provider) => void;
    onDelete: (id: string) => void;
    onSetDefault: (id: string) => void;
    onSetDefaultEnhancement: (id: string) => void;
}) {
    const i18n = useExtracted();
    if (providers.length === 0) {
        return (
            <div className="text-center py-12">
                <Bot className="size-16 mx-auto mb-4 text-muted-foreground" />
                <h3 className="font-semibold mb-2">
                    {i18n("No providers configured")}
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                    {i18n("Add an AI provider to enable transcription")}
                </p>
                <Button onClick={onAdd} size="sm">
                    <Plus className="size-4 mr-2" /> {i18n("Add Provider")}
                </Button>
            </div>
        );
    }
    return (
        <div className="space-y-3">
            {providers.map((provider) => {
                if (provider.managed === true) {
                    return (
                        <div
                            key={provider.id}
                            className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent transition-colors"
                        >
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <h3 className="font-semibold">
                                        {provider.provider}
                                    </h3>
                                    <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded border border-primary/20">
                                        {i18n("Included with your plan")}
                                    </span>
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    {provider.includedSeconds
                                        ? i18n(
                                              "Up to {hours}h of transcription per month",
                                              {
                                                  hours: String(
                                                      Math.round(
                                                          provider.includedSeconds /
                                                              3600,
                                                      ),
                                                  ),
                                              },
                                          )
                                        : i18n(
                                              "Included with your subscription",
                                          )}
                                </p>
                            </div>
                            <div className="flex items-center gap-2 ml-4">
                                {provider.isDefaultTranscription ? (
                                    <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded border border-primary/20">
                                        {i18n("Default")}
                                    </span>
                                ) : (
                                    <Button
                                        onClick={() =>
                                            onSetDefault(provider.id)
                                        }
                                        variant="outline"
                                        size="sm"
                                        disabled={provider.available === false}
                                    >
                                        {provider.available === false
                                            ? i18n("Resubscribe to use")
                                            : i18n("Use for transcription")}
                                    </Button>
                                )}
                            </div>
                        </div>
                    );
                }

                return (
                    <div
                        key={provider.id}
                        className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent transition-colors"
                    >
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                                <h3 className="font-semibold">
                                    {provider.provider}
                                </h3>
                                {provider.isDefaultTranscription && (
                                    <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded border border-primary/20">
                                        {i18n("Transcription")}
                                    </span>
                                )}
                                {provider.isDefaultEnhancement && (
                                    <span className="text-xs px-2 py-0.5 bg-purple-500/10 text-purple-600 rounded border border-purple-500/20">
                                        {i18n("Enhancement")}
                                    </span>
                                )}
                            </div>
                            {provider.defaultModel && (
                                <p className="text-sm text-muted-foreground">
                                    {i18n("Model:")} {provider.defaultModel}
                                </p>
                            )}
                            {provider.baseUrl && (
                                <p className="text-xs text-muted-foreground font-mono truncate">
                                    {provider.baseUrl}
                                </p>
                            )}
                        </div>
                        <div className="flex items-center gap-2 ml-4">
                            {!provider.isDefaultTranscription &&
                                !isEnhancementOnlyProvider(
                                    provider.provider,
                                ) && (
                                    <Button
                                        onClick={() =>
                                            onSetDefault(provider.id)
                                        }
                                        variant="outline"
                                        size="sm"
                                    >
                                        {i18n("Use for transcription")}
                                    </Button>
                                )}
                            {!provider.isDefaultEnhancement &&
                                !isTranscriptionOnlyProvider(
                                    provider.provider,
                                ) && (
                                    <Button
                                        onClick={() =>
                                            onSetDefaultEnhancement(provider.id)
                                        }
                                        variant="outline"
                                        size="sm"
                                    >
                                        {i18n("Use for AI enhancements")}
                                    </Button>
                                )}
                            <Button
                                onClick={() => onEdit(provider)}
                                variant="outline"
                                size="icon"
                            >
                                <Pencil className="size-4" />
                            </Button>
                            <Button
                                onClick={() => onDelete(provider.id)}
                                variant="outline"
                                size="icon"
                                disabled={deletingId === provider.id}
                            >
                                {deletingId === provider.id ? (
                                    <div className="animate-spin size-4 border-2 border-destructive border-t-transparent rounded-full" />
                                ) : (
                                    <Trash2 className="size-4 text-destructive" />
                                )}
                            </Button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
