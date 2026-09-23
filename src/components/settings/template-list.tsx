"use client";

import {
    ChevronLeft,
    ChevronRight,
    MoreHorizontal,
    Pencil,
    Plus,
    Trash2,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useExtracted } from "next-intl";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PresetCopy } from "@/hooks/use-preset-copy";
import {
    deleteTemplate,
    isPresetId,
    missingPresetIds,
    type PromptTemplate,
    restoreMissingPresets,
    saveTemplate,
    type TemplateConfiguration,
    type TemplateKind,
    templatePrompt,
} from "@/lib/ai/prompt-templates";

const PAGE_SIZE = 10;

interface Draft {
    /** Absent while creating a template. */
    id?: string;
    name: string;
    prompt: string;
}

export interface TemplateListProps {
    /** `PUT /api/settings/user` field the configuration is saved under. */
    field: "summaryPrompt" | "titleGenerationPrompt";
    kind: TemplateKind;
    /** Localized names and descriptions of the built-ins, by preset id. */
    presetCopy: Record<string, PresetCopy>;
    initialConfig: TemplateConfiguration;
    heading: string;
    /** Explains what the prompt must produce; shown in the edit dialog. */
    promptHelp: ReactNode;
    /**
     * The optional second role (summaries: the auto-summary template).
     * `visible` hides the badge and menu item while the feature is off
     * without forgetting the stored choice.
     */
    autoRole?: {
        field: "autoSummarizePreset";
        initialId: string | null;
        visible: boolean;
    };
    disabled?: boolean;
}

/**
 * One kind of prompt template -- summary or title -- as a paginated list
 * with roles, plus the dialog that creates and edits them.
 *
 * Owns its own state from `initialConfig` on: the sections that render it
 * wait for their settings fetch before mounting it. Saves are optimistic,
 * and each one sends the whole configuration, so a slow earlier save can
 * never resurrect a template a later one removed.
 */
export function TemplateList({
    field,
    kind,
    presetCopy,
    initialConfig,
    heading,
    promptHelp,
    autoRole,
    disabled,
}: TemplateListProps) {
    const i18n = useExtracted();
    const confirm = useConfirm();
    const [config, setConfig] = useState(initialConfig);
    const [autoId, setAutoId] = useState(autoRole?.initialId ?? null);
    const [page, setPage] = useState(0);
    const [draft, setDraft] = useState<Draft | null>(null);
    const saveAbortRef = useRef<AbortController | null>(null);

    const showAuto = !!autoRole?.visible;
    const pageCount = Math.max(
        1,
        Math.ceil(config.templates.length / PAGE_SIZE),
    );
    const currentPage = Math.min(page, pageCount - 1);
    const pageStart = currentPage * PAGE_SIZE;
    const visible = config.templates.slice(pageStart, pageStart + PAGE_SIZE);
    const missing = missingPresetIds(config, kind);

    const displayName = (t: PromptTemplate) =>
        t.name ?? presetCopy[t.id]?.name ?? t.id;

    const persist = async (
        nextConfig: TemplateConfiguration,
        nextAutoId: string | null = autoId,
    ) => {
        saveAbortRef.current?.abort();
        const ctrl = new AbortController();
        saveAbortRef.current = ctrl;
        const previous = { config, autoId };
        setConfig(nextConfig);
        setAutoId(nextAutoId);
        const patch: Record<string, unknown> = { [field]: nextConfig };
        if (autoRole && nextAutoId !== autoId) {
            patch[autoRole.field] = nextAutoId;
        }
        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
                signal: ctrl.signal,
            });
            if (!response.ok) throw new Error("Failed to save settings");
        } catch {
            // A newer save owns the displayed state; rolling back to this
            // one's `previous` would resurrect an outdated list.
            if (saveAbortRef.current !== ctrl) return;
            setConfig(previous.config);
            setAutoId(previous.autoId);
            toast.error(i18n("Failed to save settings. Changes reverted."));
        }
    };

    const handleDelete = (template: PromptTemplate) => {
        const name = displayName(template);
        const next = deleteTemplate(config, template.id);
        const newDefault = next.templates.find(
            (t) => t.id === next.selectedPrompt,
        );
        const notes: string[] = [];
        if (config.selectedPrompt === template.id && newDefault) {
            notes.push(
                i18n("{name} becomes the default template.", {
                    name: displayName(newDefault),
                }),
            );
        }
        if (showAuto && autoId === template.id) {
            notes.push(
                i18n("Auto-summary will use the default template again."),
            );
        }
        void confirm({
            title: i18n("Delete “{name}”?", { name }),
            description: [
                i18n(
                    "Recordings already processed with this template keep their results.",
                ),
                ...notes,
            ].join(" "),
            confirmLabel: i18n("Delete"),
            destructive: true,
            onConfirm: async () => {
                await persist(next, autoId === template.id ? null : autoId);
                const remainingPages = Math.ceil(
                    next.templates.length / PAGE_SIZE,
                );
                if (currentPage >= remainingPages) {
                    setPage(Math.max(0, remainingPages - 1));
                }
            },
        });
    };

    const openEditor = (template?: PromptTemplate) =>
        setDraft(
            template
                ? {
                      id: template.id,
                      name: displayName(template),
                      prompt: templatePrompt(template, kind),
                  }
                : { name: "", prompt: "" },
        );

    const handleSave = () => {
        if (!draft) return;
        const next = saveTemplate(config, draft, kind, {
            newId: nanoid,
            builtinName: draft.id ? presetCopy[draft.id]?.name : undefined,
        });
        setDraft(null);
        if (!draft.id) {
            // Show the page the new template landed on.
            setPage(Math.floor((next.templates.length - 1) / PAGE_SIZE));
        }
        void persist(next);
    };

    const draftBuiltin =
        draft?.id && isPresetId(kind, draft.id)
            ? {
                  name: presetCopy[draft.id]?.name ?? draft.id,
                  prompt: kind.presets[draft.id].prompt,
              }
            : null;
    const draftIsBuiltinVersion =
        !!draftBuiltin &&
        draft?.name.trim() === draftBuiltin.name &&
        draft?.prompt.trim() === draftBuiltin.prompt.trim();

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
                <h3 className="text-base font-medium">{heading}</h3>
                <Button
                    size="sm"
                    onClick={() => openEditor()}
                    disabled={disabled}
                >
                    <Plus className="size-4 mr-2" />
                    {i18n("New template")}
                </Button>
            </div>

            <ul className="divide-y border rounded-lg">
                {visible.map((template) => {
                    const name = displayName(template);
                    const builtin = isPresetId(kind, template.id);
                    const edited =
                        template.name !== null || template.prompt !== null;
                    const isDefault = config.selectedPrompt === template.id;
                    const isAuto = showAuto && autoId === template.id;
                    const origin = !builtin
                        ? i18n("Custom")
                        : edited
                          ? i18n("Built-in, edited")
                          : i18n("Built-in");
                    const description = builtin
                        ? presetCopy[template.id]?.description
                        : undefined;
                    return (
                        <li
                            key={template.id}
                            className="flex items-center gap-3 px-4 py-3"
                        >
                            <div className="min-w-0 flex-1 space-y-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium">{name}</span>
                                    {isDefault && (
                                        <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded border border-primary/20">
                                            {i18n("Default")}
                                        </span>
                                    )}
                                    {isAuto && (
                                        <span className="text-xs px-2 py-0.5 bg-muted text-foreground rounded border">
                                            {i18n("Auto-summary")}
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs text-muted-foreground line-clamp-1 break-words">
                                    {description
                                        ? `${origin} · ${description}`
                                        : origin}
                                </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={i18n(
                                                "More actions for {name}",
                                                { name },
                                            )}
                                            disabled={disabled}
                                        >
                                            <MoreHorizontal className="size-4" />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuItem
                                            disabled={isDefault}
                                            onSelect={() =>
                                                void persist({
                                                    ...config,
                                                    selectedPrompt: template.id,
                                                })
                                            }
                                        >
                                            {i18n("Make default")}
                                        </DropdownMenuItem>
                                        {showAuto && (
                                            <DropdownMenuItem
                                                onSelect={() =>
                                                    void persist(
                                                        config,
                                                        isAuto
                                                            ? null
                                                            : template.id,
                                                    )
                                                }
                                            >
                                                {isAuto
                                                    ? i18n(
                                                          "Stop using for auto-summary",
                                                      )
                                                    : i18n(
                                                          "Use for auto-summary",
                                                      )}
                                            </DropdownMenuItem>
                                        )}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={i18n("Edit {name}", { name })}
                                    onClick={() => openEditor(template)}
                                    disabled={disabled}
                                >
                                    <Pencil className="size-4" />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={i18n("Delete {name}", {
                                        name,
                                    })}
                                    onClick={() => handleDelete(template)}
                                    disabled={
                                        disabled || config.templates.length <= 1
                                    }
                                >
                                    <Trash2 className="size-4 text-destructive" />
                                </Button>
                            </div>
                        </li>
                    );
                })}
            </ul>

            {(pageCount > 1 || missing.length > 0) && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                    {missing.length > 0 ? (
                        <Button
                            variant="link"
                            size="sm"
                            className="px-0"
                            onClick={() =>
                                void persist(
                                    restoreMissingPresets(config, kind),
                                )
                            }
                            disabled={disabled}
                        >
                            {i18n("Add built-in templates back")}
                        </Button>
                    ) : (
                        <span />
                    )}
                    {pageCount > 1 && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Button
                                variant="outline"
                                size="icon-sm"
                                aria-label={i18n("Previous page")}
                                onClick={() => setPage(currentPage - 1)}
                                disabled={currentPage === 0}
                            >
                                <ChevronLeft className="size-4" />
                            </Button>
                            <span>
                                {i18n(
                                    "{from, number}–{to, number} of {total, number}",
                                    {
                                        from: pageStart + 1,
                                        to: pageStart + visible.length,
                                        total: config.templates.length,
                                    },
                                )}
                            </span>
                            <Button
                                variant="outline"
                                size="icon-sm"
                                aria-label={i18n("Next page")}
                                onClick={() => setPage(currentPage + 1)}
                                disabled={currentPage >= pageCount - 1}
                            >
                                <ChevronRight className="size-4" />
                            </Button>
                        </div>
                    )}
                </div>
            )}

            {draft && (
                <Dialog
                    open={!!draft}
                    onOpenChange={(open) => !open && setDraft(null)}
                >
                    <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-y-auto">
                        <DialogTitle>
                            {draft.id
                                ? i18n("Edit template")
                                : i18n("New template")}
                        </DialogTitle>
                        <DialogDescription>{promptHelp}</DialogDescription>
                        <div className="space-y-4 mt-4">
                            <div className="space-y-2">
                                <Label htmlFor={`${field}-template-name`}>
                                    {i18n("Name")}
                                </Label>
                                <Input
                                    id={`${field}-template-name`}
                                    value={draft.name}
                                    onChange={(e) =>
                                        setDraft({
                                            ...draft,
                                            name: e.target.value,
                                        })
                                    }
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor={`${field}-template-prompt`}>
                                    {i18n("Prompt")}
                                </Label>
                                <textarea
                                    id={`${field}-template-prompt`}
                                    className="w-full min-h-[360px] px-3 py-2 text-sm border rounded-md resize-y font-mono"
                                    value={draft.prompt}
                                    onChange={(e) =>
                                        setDraft({
                                            ...draft,
                                            prompt: e.target.value,
                                        })
                                    }
                                />
                                {draft.prompt &&
                                    !draft.prompt.includes(
                                        "{transcription}",
                                    ) && (
                                        <p className="text-xs text-amber-600 dark:text-amber-500">
                                            {i18n(
                                                "This prompt doesn't include",
                                            )}{" "}
                                            <code className="px-1 py-0.5 bg-muted rounded">
                                                {"{transcription}"}
                                            </code>{" "}
                                            {i18n(
                                                "-- the transcript won't be inserted, and the model will only see this literal text.",
                                            )}
                                        </p>
                                    )}
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                {draftBuiltin ? (
                                    <Button
                                        variant="ghost"
                                        onClick={() =>
                                            setDraft({
                                                ...draft,
                                                name: draftBuiltin.name,
                                                prompt: draftBuiltin.prompt,
                                            })
                                        }
                                        disabled={draftIsBuiltinVersion}
                                    >
                                        {i18n("Restore built-in version")}
                                    </Button>
                                ) : (
                                    <span />
                                )}
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        onClick={() => setDraft(null)}
                                    >
                                        {i18n("Cancel")}
                                    </Button>
                                    <Button
                                        onClick={handleSave}
                                        disabled={
                                            !draft.name.trim() ||
                                            !draft.prompt.trim()
                                        }
                                    >
                                        {i18n("Save")}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </DialogContent>
                </Dialog>
            )}
        </div>
    );
}
