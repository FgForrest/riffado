"use client";

import { ListChecks, Pencil } from "lucide-react";
import { useExtracted, useLocale } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { TemplateList } from "@/components/settings/template-list";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useSummaryPresetCopy } from "@/hooks/use-preset-copy";
import { useSettings } from "@/hooks/use-settings";
import type { TemplateConfiguration } from "@/lib/ai/prompt-templates";
import {
    AI_OUTPUT_LANGUAGES,
    normalizeSummaryPromptConfig,
    SUMMARY_TEMPLATE_KIND,
} from "@/lib/ai/summary-presets";
import {
    DEFAULT_MERGE_PROMPT,
    MULTI_PASS_ROUNDS_DEFAULT,
    MULTI_PASS_ROUNDS_MAX,
    MULTI_PASS_ROUNDS_MIN,
} from "@/lib/summary/multi-pass";

const ROUND_OPTIONS = Array.from(
    { length: MULTI_PASS_ROUNDS_MAX - MULTI_PASS_ROUNDS_MIN + 1 },
    (_, i) => MULTI_PASS_ROUNDS_MIN + i,
);

export function SummarySection() {
    const i18n = useExtracted();
    const locale = useLocale();
    const languageNames = new Intl.DisplayNames([locale], { type: "language" });
    const languageLabel = (code: string) =>
        code === "auto"
            ? i18n("Auto (match transcript)")
            : (languageNames.of(code) ?? code);
    const presetCopy = useSummaryPresetCopy();
    const { isLoadingSettings, isSavingSettings, setIsLoadingSettings } =
        useSettings();
    const [outputLanguage, setOutputLanguage] = useState<string>("auto");
    const [autoSummarize, setAutoSummarize] = useState(false);
    // Starting state for <TemplateList>, which owns it once mounted: the
    // list renders only after this fetch has settled.
    const [templates, setTemplates] = useState<{
        config: TemplateConfiguration;
        autoId: string | null;
    }>(() => ({ config: normalizeSummaryPromptConfig(null), autoId: null }));
    const [multiPass, setMultiPass] = useState(false);
    const [multiPassRounds, setMultiPassRounds] = useState(
        MULTI_PASS_ROUNDS_DEFAULT,
    );
    const [multiPassAuto, setMultiPassAuto] = useState(false);
    // Empty string means "no custom prompt" -- the column is NULL and the
    // built-in DEFAULT_MERGE_PROMPT is used.
    const [savedMergePrompt, setSavedMergePrompt] = useState("");
    // The merge prompt dialog's working copy; null while the dialog is closed.
    const [mergePromptDraft, setMergePromptDraft] = useState<string | null>(
        null,
    );

    // Per-control AbortController refs so a fast-double-toggle can't let
    // a slow earlier save fail *after* a newer save succeeded and clobber
    // the displayed state with stale `previous` values. Each handler
    // aborts its predecessor and bails out of rollback when its own
    // controller is no longer the latest.
    const languageAbortRef = useRef<AbortController | null>(null);
    const autoSummarizeAbortRef = useRef<AbortController | null>(null);
    // Same rationale, but keyed by field: the multi-pass group has four
    // controls, and switching the feature on then immediately changing the
    // pass count are two independent saves that must not cancel each other.
    const multiPassAbortRefs = useRef<Record<string, AbortController | null>>(
        {},
    );

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const response = await fetch("/api/settings/user");
                if (response.ok) {
                    const data = await response.json();
                    setTemplates({
                        config: normalizeSummaryPromptConfig(
                            data.summaryPrompt,
                        ),
                        autoId:
                            typeof data.autoSummarizePreset === "string"
                                ? data.autoSummarizePreset
                                : null,
                    });
                    if (typeof data.aiOutputLanguage === "string") {
                        setOutputLanguage(data.aiOutputLanguage);
                    } else {
                        setOutputLanguage("auto");
                    }
                    setAutoSummarize(data.autoSummarize === true);
                    setMultiPass(data.summaryMultiPass === true);
                    setMultiPassRounds(
                        typeof data.summaryMultiPassRounds === "number"
                            ? data.summaryMultiPassRounds
                            : MULTI_PASS_ROUNDS_DEFAULT,
                    );
                    setMultiPassAuto(data.summaryMultiPassAuto === true);
                    setSavedMergePrompt(
                        typeof data.summaryMergePrompt === "string"
                            ? data.summaryMergePrompt
                            : "",
                    );
                }
            } catch (error) {
                console.error("Failed to fetch settings:", error);
            } finally {
                setIsLoadingSettings(false);
            }
        };
        fetchSettings();
    }, [setIsLoadingSettings]);

    const handleLanguageChange = async (value: string) => {
        languageAbortRef.current?.abort();
        const ctrl = new AbortController();
        languageAbortRef.current = ctrl;
        const previous = outputLanguage;
        setOutputLanguage(value);

        try {
            // Persist `null` for `auto` so the column reflects "no preference".
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    aiOutputLanguage: value === "auto" ? null : value,
                }),
                signal: ctrl.signal,
            });

            if (!response.ok) {
                throw new Error("Failed to save settings");
            }
        } catch {
            if (languageAbortRef.current !== ctrl) return;
            setOutputLanguage(previous);
            toast.error(i18n("Failed to save settings. Changes reverted."));
        }
    };

    const handleAutoSummarizeChange = async (checked: boolean) => {
        autoSummarizeAbortRef.current?.abort();
        const ctrl = new AbortController();
        autoSummarizeAbortRef.current = ctrl;
        const previous = autoSummarize;
        setAutoSummarize(checked);
        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ autoSummarize: checked }),
                signal: ctrl.signal,
            });
            if (!response.ok) {
                throw new Error("Failed to save settings");
            }
        } catch {
            if (autoSummarizeAbortRef.current !== ctrl) return;
            setAutoSummarize(previous);
            toast.error(i18n("Failed to save settings. Changes reverted."));
        }
    };

    /**
     * One saver for the multi-pass group instead of four more copies of the
     * optimistic-save dance above. Same contract as those: abort this
     * control's predecessor, and only roll back when this call is still the
     * latest for that control.
     */
    const saveMultiPass = async (
        key: string,
        patch: Record<string, unknown>,
        rollback: () => void,
    ) => {
        multiPassAbortRefs.current[key]?.abort();
        const ctrl = new AbortController();
        multiPassAbortRefs.current[key] = ctrl;
        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
                signal: ctrl.signal,
            });
            if (!response.ok) {
                throw new Error("Failed to save settings");
            }
        } catch {
            if (multiPassAbortRefs.current[key] !== ctrl) return;
            rollback();
            toast.error(i18n("Failed to save settings. Changes reverted."));
        }
    };

    const handleMultiPassChange = (checked: boolean) => {
        const previous = multiPass;
        setMultiPass(checked);
        return saveMultiPass("enabled", { summaryMultiPass: checked }, () =>
            setMultiPass(previous),
        );
    };

    const handleMultiPassRoundsChange = (value: string) => {
        const previous = multiPassRounds;
        const next = Number(value);
        setMultiPassRounds(next);
        return saveMultiPass("rounds", { summaryMultiPassRounds: next }, () =>
            setMultiPassRounds(previous),
        );
    };

    const handleMultiPassAutoChange = (checked: boolean) => {
        const previous = multiPassAuto;
        setMultiPassAuto(checked);
        return saveMultiPass("auto", { summaryMultiPassAuto: checked }, () =>
            setMultiPassAuto(previous),
        );
    };

    const handleSaveMergePrompt = () => {
        if (mergePromptDraft === null) return;
        const trimmed = mergePromptDraft.trim();
        // The built-in text is stored as NULL rather than verbatim: a copy
        // would pin this user to today's default and hide every later
        // improvement to it. A blank field means the same thing.
        const next = trimmed === DEFAULT_MERGE_PROMPT ? "" : trimmed;
        setMergePromptDraft(null);
        if (next === savedMergePrompt) return;
        const previous = savedMergePrompt;
        setSavedMergePrompt(next);
        return saveMultiPass(
            "merge-prompt",
            { summaryMergePrompt: next || null },
            () => setSavedMergePrompt(previous),
        );
    };

    if (isLoadingSettings) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="animate-spin size-6 border-2 border-primary border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <SettingsSectionHeader
                title={i18n("Summary")}
                description={i18n(
                    "Prompt presets and provider used when generating recording summaries.",
                )}
                icon={ListChecks}
            />
            <div className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="ai-output-language">
                        {i18n("AI output language")}
                    </Label>
                    <Select
                        value={outputLanguage}
                        onValueChange={handleLanguageChange}
                        disabled={isSavingSettings}
                    >
                        <SelectTrigger
                            id="ai-output-language"
                            className="w-full"
                        >
                            <SelectValue>
                                {languageLabel(outputLanguage)}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {AI_OUTPUT_LANGUAGES.map((lang) => (
                                <SelectItem key={lang.code} value={lang.code}>
                                    {languageLabel(lang.code)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "Applies to AI-generated summaries and titles. Auto lets the model match the transcript's language.",
                        )}
                    </p>
                </div>
                <div className="flex items-center justify-between pt-2">
                    <div className="space-y-0.5 flex-1">
                        <Label htmlFor="auto-summarize" className="text-base">
                            {i18n("Auto-generate summary after transcription")}
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Triggers after any successful transcription — manual, auto-sync, or re-transcribe. Enable Auto-transcribe to also cover newly synced recordings. Costs one extra AI provider call per generated summary.",
                            )}{" "}
                            {i18n(
                                "It uses the template marked Auto-summary below, or the default template if none is.",
                            )}
                        </p>
                    </div>
                    <Switch
                        id="auto-summarize"
                        checked={autoSummarize}
                        onCheckedChange={handleAutoSummarizeChange}
                        disabled={isSavingSettings}
                    />
                </div>
            </div>

            <div className="pt-4 border-t">
                <TemplateList
                    field="summaryPrompt"
                    kind={SUMMARY_TEMPLATE_KIND}
                    presetCopy={presetCopy}
                    initialConfig={templates.config}
                    heading={i18n("Summary templates")}
                    promptHelp={
                        <>
                            {i18n("Use")}{" "}
                            <code className="px-1 py-0.5 bg-muted rounded">
                                {"{transcription}"}
                            </code>{" "}
                            {i18n(
                                "as a placeholder for the transcription text. The model must respond with a JSON object containing",
                            )}{" "}
                            <code className="px-1 py-0.5 bg-muted rounded">
                                {"summary"}
                            </code>
                            ,{" "}
                            <code className="px-1 py-0.5 bg-muted rounded">
                                {"keyPoints"}
                            </code>{" "}
                            {i18n(", and")}{" "}
                            <code className="px-1 py-0.5 bg-muted rounded">
                                {"actionItems"}
                            </code>{" "}
                            {i18n("fields.")}
                        </>
                    }
                    autoRole={{
                        field: "autoSummarizePreset",
                        initialId: templates.autoId,
                        visible: autoSummarize,
                    }}
                    disabled={isSavingSettings}
                />
            </div>

            {/* Multi-pass summarization */}
            <div className="space-y-4 pt-4 border-t">
                <div className="flex items-center justify-between">
                    <div className="space-y-0.5 flex-1">
                        <Label htmlFor="multi-pass" className="text-base">
                            {i18n("Multi-pass summarization")}
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Summarizes the transcript several times in parallel and merges the results. Independent passes leave out different things, so the merged summary leaves out less. It does not make any individual fact more accurate.",
                            )}
                        </p>
                    </div>
                    <Switch
                        id="multi-pass"
                        checked={multiPass}
                        onCheckedChange={handleMultiPassChange}
                        disabled={isSavingSettings}
                    />
                </div>
                {multiPass && (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor="multi-pass-rounds">
                                {i18n("Passes per summary")}
                            </Label>
                            <Select
                                value={String(multiPassRounds)}
                                onValueChange={handleMultiPassRoundsChange}
                                disabled={isSavingSettings}
                            >
                                <SelectTrigger
                                    id="multi-pass-rounds"
                                    className="w-full"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {ROUND_OPTIONS.map((count) => (
                                        <SelectItem
                                            key={count}
                                            value={String(count)}
                                        >
                                            {count} {i18n("passes")}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                                {i18n(
                                    "Every pass re-sends the whole transcript, so",
                                )}{" "}
                                {multiPassRounds} {i18n("passes costs roughly")}{" "}
                                {multiPassRounds}
                                {i18n(
                                    "× the tokens of a single summary; the merge adds only a few percent on top. On a provider backed by a subscription rather than an API key, what this spends is your rate limit rather than money. Passes run concurrently only if your provider accepts concurrent requests — otherwise they queue, and the summary takes correspondingly longer.",
                                )}
                            </p>
                        </div>
                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5 flex-1">
                                <Label
                                    htmlFor="multi-pass-auto"
                                    className="text-base"
                                >
                                    {i18n("Also use for auto-summary")}
                                </Label>
                                <p className="text-sm text-muted-foreground">
                                    {i18n(
                                        "Off by default. A manual summary is one recording you are waiting on; a single sync can generate a dozen, and each one multiplies by the pass count.",
                                    )}
                                </p>
                            </div>
                            <Switch
                                id="multi-pass-auto"
                                checked={multiPassAuto}
                                onCheckedChange={handleMultiPassAutoChange}
                                disabled={isSavingSettings}
                            />
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center justify-between gap-4">
                                <div className="space-y-0.5 flex-1">
                                    <h4 className="text-base font-medium">
                                        {i18n("Merge prompt")}
                                    </h4>
                                    <p className="text-sm text-muted-foreground">
                                        {savedMergePrompt
                                            ? i18n(
                                                  "Using your custom merge prompt.",
                                              )
                                            : i18n(
                                                  "Using the built-in merge prompt.",
                                              )}
                                    </p>
                                </div>
                                <Button
                                    size="sm"
                                    onClick={() =>
                                        setMergePromptDraft(
                                            savedMergePrompt ||
                                                DEFAULT_MERGE_PROMPT,
                                        )
                                    }
                                    disabled={isSavingSettings}
                                >
                                    <Pencil className="size-4 mr-2" />
                                    {i18n("Change merge prompt")}
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {i18n(
                                    "The built-in prompt treats the merge as a union and de-duplication of the passes rather than a fresh summary, which is what keeps a point found by only one pass from being dropped. Replace it only if you need different merge behaviour — the passes themselves are steered by your summary prompt above.",
                                )}
                            </p>
                        </div>
                    </>
                )}
            </div>

            {/* Edit merge prompt dialog */}
            {mergePromptDraft !== null && (
                <Dialog
                    open={mergePromptDraft !== null}
                    onOpenChange={(open) => !open && setMergePromptDraft(null)}
                >
                    <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-y-auto">
                        <DialogTitle>{i18n("Merge prompt")}</DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "Combines the passes into one summary. The model receives every pass as a JSON object with",
                            )}{" "}
                            <code className="px-1 py-0.5 bg-muted rounded">
                                {"summary"}
                            </code>
                            ,{" "}
                            <code className="px-1 py-0.5 bg-muted rounded">
                                {"keyPoints"}
                            </code>{" "}
                            {i18n(", and")}{" "}
                            <code className="px-1 py-0.5 bg-muted rounded">
                                {"actionItems"}
                            </code>{" "}
                            {i18n(
                                "fields, and must return a single object of the same shape.",
                            )}
                        </DialogDescription>
                        <div className="space-y-4 mt-4">
                            <textarea
                                aria-label={i18n("Merge prompt")}
                                className="w-full min-h-[360px] px-3 py-2 text-sm border rounded-md resize-y font-mono"
                                value={mergePromptDraft}
                                onChange={(e) =>
                                    setMergePromptDraft(e.target.value)
                                }
                            />
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <Button
                                    variant="ghost"
                                    onClick={() =>
                                        setMergePromptDraft(
                                            DEFAULT_MERGE_PROMPT,
                                        )
                                    }
                                    disabled={
                                        mergePromptDraft.trim() ===
                                        DEFAULT_MERGE_PROMPT
                                    }
                                >
                                    {i18n("Restore built-in prompt")}
                                </Button>
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        onClick={() =>
                                            setMergePromptDraft(null)
                                        }
                                    >
                                        {i18n("Cancel")}
                                    </Button>
                                    <Button onClick={handleSaveMergePrompt}>
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
