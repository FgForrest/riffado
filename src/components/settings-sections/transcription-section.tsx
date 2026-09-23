"use client";

import { FileText } from "lucide-react";
import { useExtracted } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { TemplateList } from "@/components/settings/template-list";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
    useTitlePresetCopy,
    useTopicPresetCopy,
} from "@/hooks/use-preset-copy";
import { useSettings } from "@/hooks/use-settings";
import {
    normalizeTitlePromptConfig,
    TITLE_TEMPLATE_KIND,
} from "@/lib/ai/prompt-presets";
import {
    normalizeTopicPromptConfig,
    TOPIC_TEMPLATE_KIND,
} from "@/lib/topics/topic-presets";

// ISO-639-1 codes from Whisper's supported-languages list. Sticking to
// languages with non-trivial user populations to keep the dropdown
// scannable. Auto-detect already covers everything Whisper handles —
// these entries just let users force a language for noisy recordings
// or when auto-detect mis-routes (Slavic / Romance neighbours).
export function TranscriptionSection() {
    const i18n = useExtracted();
    const languageOptions = useMemo(
        () => [
            { label: i18n("Auto-detect"), value: null },
            { label: i18n("English"), value: "en" },
            { label: i18n("Spanish"), value: "es" },
            { label: i18n("French"), value: "fr" },
            { label: i18n("German"), value: "de" },
            { label: i18n("Italian"), value: "it" },
            { label: i18n("Portuguese"), value: "pt" },
            { label: i18n("Dutch"), value: "nl" },
            { label: i18n("Swedish"), value: "sv" },
            { label: i18n("Danish"), value: "da" },
            { label: i18n("Norwegian"), value: "no" },
            { label: i18n("Finnish"), value: "fi" },
            { label: i18n("Polish"), value: "pl" },
            { label: i18n("Czech"), value: "cs" },
            { label: i18n("Ukrainian"), value: "uk" },
            { label: i18n("Russian"), value: "ru" },
            { label: i18n("Romanian"), value: "ro" },
            { label: i18n("Hungarian"), value: "hu" },
            { label: i18n("Greek"), value: "el" },
            { label: i18n("Turkish"), value: "tr" },
            { label: i18n("Arabic"), value: "ar" },
            { label: i18n("Hebrew"), value: "he" },
            { label: i18n("Hindi"), value: "hi" },
            { label: i18n("Indonesian"), value: "id" },
            { label: i18n("Vietnamese"), value: "vi" },
            { label: i18n("Thai"), value: "th" },
            { label: i18n("Chinese"), value: "zh" },
            { label: i18n("Japanese"), value: "ja" },
            { label: i18n("Korean"), value: "ko" },
        ],
        [i18n],
    );
    const qualityOptions = useMemo(
        () => [
            {
                label: i18n("Fast"),
                value: "fast",
                description: i18n("Faster transcription, lower accuracy"),
            },
            {
                label: i18n("Balanced"),
                value: "balanced",
                description: i18n("Good balance of speed and accuracy"),
            },
            {
                label: i18n("Accurate"),
                value: "accurate",
                description: i18n("Highest accuracy, slower transcription"),
            },
        ],
        [i18n],
    );
    const { isLoadingSettings, isSavingSettings, setIsLoadingSettings } =
        useSettings();
    const [autoTranscribe, setAutoTranscribe] = useState(false);
    const [defaultTranscriptionLanguage, setDefaultTranscriptionLanguage] =
        useState<string | null>(null);
    const [transcriptionQuality, setTranscriptionQuality] =
        useState("balanced");
    const [autoGenerateTitle, setAutoGenerateTitle] = useState(true);
    const [syncTitleToPlaud, setSyncTitleToPlaud] = useState(false);
    // Starting state for <TemplateList>, which owns it once mounted: the
    // list renders only after the settings fetch has settled.
    const [titleTemplates, setTitleTemplates] = useState(() =>
        normalizeTitlePromptConfig(null),
    );
    const titlePresetCopy = useTitlePresetCopy();
    const [autoDetectTopics, setAutoDetectTopics] = useState(false);
    // Starting state for the topic <TemplateList>, as for titles.
    const [topicTemplates, setTopicTemplates] = useState(() =>
        normalizeTopicPromptConfig(null),
    );
    const topicPresetCopy = useTopicPresetCopy();
    const [importPlaudContent, setImportPlaudContent] = useState(false);
    const [transcriptMode, setTranscriptMode] = useState("plaud_only");
    const [preferredTranscriptSource, setPreferredTranscriptSource] =
        useState("plaud");
    const pendingChangesRef = useRef<Map<string, unknown>>(new Map());

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const response = await fetch("/api/settings/user");
                if (response.ok) {
                    const data = await response.json();
                    setAutoTranscribe(data.autoTranscribe ?? false);
                    setDefaultTranscriptionLanguage(
                        data.defaultTranscriptionLanguage ?? null,
                    );
                    setTranscriptionQuality(
                        data.transcriptionQuality ?? "balanced",
                    );
                    setAutoGenerateTitle(data.autoGenerateTitle ?? true);
                    setSyncTitleToPlaud(data.syncTitleToPlaud ?? false);
                    setTitleTemplates(
                        normalizeTitlePromptConfig(data.titleGenerationPrompt),
                    );
                    setAutoDetectTopics(data.autoDetectTopics ?? false);
                    setTopicTemplates(
                        normalizeTopicPromptConfig(data.topicPrompt),
                    );
                    setImportPlaudContent(data.importPlaudContent ?? false);
                    setTranscriptMode(data.transcriptMode ?? "plaud_only");
                    setPreferredTranscriptSource(
                        data.preferredTranscriptSource ?? "plaud",
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

    const handleAutoTranscribeChange = async (checked: boolean) => {
        const previous = autoTranscribe;
        setAutoTranscribe(checked);
        pendingChangesRef.current.set("autoTranscribe", previous);

        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ autoTranscribe: checked }),
            });

            if (!response.ok) {
                throw new Error("Failed to save settings");
            }

            pendingChangesRef.current.delete("autoTranscribe");
        } catch {
            setAutoTranscribe(previous);
            pendingChangesRef.current.delete("autoTranscribe");
            toast.error(i18n("Failed to save settings. Changes reverted."));
        }
    };

    const handleAutoDetectTopicsChange = async (checked: boolean) => {
        const previous = autoDetectTopics;
        setAutoDetectTopics(checked);
        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ autoDetectTopics: checked }),
            });
            if (!response.ok) {
                throw new Error("Failed to save settings");
            }
        } catch {
            setAutoDetectTopics(previous);
            toast.error(i18n("Failed to save settings. Changes reverted."));
        }
    };

    const handleImportSettingChange = async (updates: {
        importPlaudContent?: boolean;
        transcriptMode?: string;
        preferredTranscriptSource?: string;
    }) => {
        const prev = {
            importPlaudContent,
            transcriptMode,
            preferredTranscriptSource,
        };
        if (updates.importPlaudContent !== undefined) {
            setImportPlaudContent(updates.importPlaudContent);
        }
        if (updates.transcriptMode !== undefined) {
            setTranscriptMode(updates.transcriptMode);
        }
        if (updates.preferredTranscriptSource !== undefined) {
            setPreferredTranscriptSource(updates.preferredTranscriptSource);
        }

        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(updates),
            });
            if (!response.ok) {
                throw new Error("Failed to save settings");
            }
        } catch {
            setImportPlaudContent(prev.importPlaudContent);
            setTranscriptMode(prev.transcriptMode);
            setPreferredTranscriptSource(prev.preferredTranscriptSource);
            toast.error(i18n("Failed to save settings. Changes reverted."));
        }
    };

    const handleTranscriptionSettingChange = async (updates: {
        defaultTranscriptionLanguage?: string | null;
        transcriptionQuality?: string;
        autoGenerateTitle?: boolean;
        syncTitleToPlaud?: boolean;
    }) => {
        if (updates.defaultTranscriptionLanguage !== undefined) {
            const previous = defaultTranscriptionLanguage;
            setDefaultTranscriptionLanguage(
                updates.defaultTranscriptionLanguage,
            );
            pendingChangesRef.current.set(
                "defaultTranscriptionLanguage",
                previous,
            );
        }
        if (updates.transcriptionQuality !== undefined) {
            const previous = transcriptionQuality;
            setTranscriptionQuality(updates.transcriptionQuality);
            pendingChangesRef.current.set("transcriptionQuality", previous);
        }
        if (updates.autoGenerateTitle !== undefined) {
            const previous = autoGenerateTitle;
            setAutoGenerateTitle(updates.autoGenerateTitle);
            pendingChangesRef.current.set("autoGenerateTitle", previous);
        }
        if (updates.syncTitleToPlaud !== undefined) {
            const previous = syncTitleToPlaud;
            setSyncTitleToPlaud(updates.syncTitleToPlaud);
            pendingChangesRef.current.set("syncTitleToPlaud", previous);
        }

        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(updates),
            });

            if (!response.ok) {
                throw new Error("Failed to save settings");
            }

            if (updates.defaultTranscriptionLanguage !== undefined) {
                pendingChangesRef.current.delete(
                    "defaultTranscriptionLanguage",
                );
            }
            if (updates.transcriptionQuality !== undefined) {
                pendingChangesRef.current.delete("transcriptionQuality");
            }
            if (updates.autoGenerateTitle !== undefined) {
                pendingChangesRef.current.delete("autoGenerateTitle");
            }
            if (updates.syncTitleToPlaud !== undefined) {
                pendingChangesRef.current.delete("syncTitleToPlaud");
            }
        } catch {
            if (updates.defaultTranscriptionLanguage !== undefined) {
                const previous = pendingChangesRef.current.get(
                    "defaultTranscriptionLanguage",
                );
                if (
                    previous !== undefined &&
                    (typeof previous === "string" || previous === null)
                ) {
                    setDefaultTranscriptionLanguage(previous);
                    pendingChangesRef.current.delete(
                        "defaultTranscriptionLanguage",
                    );
                }
            }
            if (updates.transcriptionQuality !== undefined) {
                const previous = pendingChangesRef.current.get(
                    "transcriptionQuality",
                );
                if (previous !== undefined && typeof previous === "string") {
                    setTranscriptionQuality(previous);
                    pendingChangesRef.current.delete("transcriptionQuality");
                }
            }
            if (updates.autoGenerateTitle !== undefined) {
                const previous =
                    pendingChangesRef.current.get("autoGenerateTitle");
                if (previous !== undefined && typeof previous === "boolean") {
                    setAutoGenerateTitle(previous);
                    pendingChangesRef.current.delete("autoGenerateTitle");
                }
            }
            if (updates.syncTitleToPlaud !== undefined) {
                const previous =
                    pendingChangesRef.current.get("syncTitleToPlaud");
                if (previous !== undefined && typeof previous === "boolean") {
                    setSyncTitleToPlaud(previous);
                    pendingChangesRef.current.delete("syncTitleToPlaud");
                }
            }
            toast.error(i18n("Failed to save settings. Changes reverted."));
        }
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
                title={i18n("Transcription")}
                description={i18n(
                    "Defaults and provider selection for converting audio to text.",
                )}
                icon={FileText}
            />
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <div className="space-y-0.5 flex-1">
                        <Label htmlFor="auto-transcribe" className="text-base">
                            {i18n("Auto-transcribe new recordings")}
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Automatically transcribe every new recording, whether synced from a voice recorder or uploaded",
                            )}
                        </p>
                    </div>
                    <Switch
                        id="auto-transcribe"
                        checked={autoTranscribe}
                        onCheckedChange={handleAutoTranscribeChange}
                        disabled={isSavingSettings}
                    />
                </div>

                <div className="flex items-center justify-between">
                    <div className="space-y-0.5 flex-1">
                        <Label
                            htmlFor="import-plaud-content"
                            className="text-base"
                        >
                            {i18n("Import Plaud transcripts and summaries")}
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "When Plaud already transcribed a recording, import its transcript and summary on sync instead of re-doing the work with your own AI provider.",
                            )}
                        </p>
                    </div>
                    <Switch
                        id="import-plaud-content"
                        checked={importPlaudContent}
                        onCheckedChange={(checked) =>
                            handleImportSettingChange({
                                importPlaudContent: checked,
                            })
                        }
                        disabled={isSavingSettings}
                    />
                </div>

                {importPlaudContent && (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor="transcript-mode">
                                {i18n("When Plaud has a transcript")}
                            </Label>
                            <Select
                                value={transcriptMode}
                                onValueChange={(value) =>
                                    handleImportSettingChange({
                                        transcriptMode: value,
                                    })
                                }
                                disabled={isSavingSettings}
                            >
                                <SelectTrigger
                                    id="transcript-mode"
                                    className="w-full"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="plaud_only">
                                        {i18n(
                                            "Use Plaud only (saves AI credits)",
                                        )}
                                    </SelectItem>
                                    <SelectItem value="keep_both">
                                        {i18n(
                                            "Keep both — also run my provider",
                                        )}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                                {i18n(
                                    "Keep both also transcribes with your own provider so you can compare them.",
                                )}
                            </p>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="preferred-transcript-source">
                                {i18n("Primary transcript")}
                            </Label>
                            <Select
                                value={preferredTranscriptSource}
                                onValueChange={(value) =>
                                    handleImportSettingChange({
                                        preferredTranscriptSource: value,
                                    })
                                }
                                disabled={isSavingSettings}
                            >
                                <SelectTrigger
                                    id="preferred-transcript-source"
                                    className="w-full"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="plaud">
                                        {i18n("Plaud")}
                                    </SelectItem>
                                    <SelectItem value="riffado">
                                        {i18n("My provider")}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                                {i18n(
                                    "Shown by default and used for summaries when both exist.",
                                )}
                            </p>
                        </div>
                    </>
                )}

                <div className="space-y-2">
                    <Label htmlFor="transcription-language">
                        {i18n("Default transcription language")}
                    </Label>
                    <Select
                        value={defaultTranscriptionLanguage || "auto"}
                        onValueChange={(value) => {
                            const lang = value === "auto" ? null : value;
                            setDefaultTranscriptionLanguage(lang);
                            handleTranscriptionSettingChange({
                                defaultTranscriptionLanguage: lang,
                            });
                        }}
                        disabled={isSavingSettings}
                    >
                        <SelectTrigger
                            id="transcription-language"
                            className="w-full"
                        >
                            <SelectValue>
                                {languageOptions.find(
                                    (opt) =>
                                        opt.value ===
                                        defaultTranscriptionLanguage,
                                )?.label || i18n("Auto-detect")}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {languageOptions.map((option) => (
                                <SelectItem
                                    key={option.value || "auto"}
                                    value={option.value || "auto"}
                                >
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "Language to use for transcription. Auto-detect will identify the language automatically.",
                        )}
                    </p>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="transcription-quality">
                        {i18n("Transcription quality")}
                    </Label>
                    <Select
                        value={transcriptionQuality}
                        onValueChange={(value) => {
                            setTranscriptionQuality(value);
                            handleTranscriptionSettingChange({
                                transcriptionQuality: value,
                            });
                        }}
                        disabled={isSavingSettings}
                    >
                        <SelectTrigger
                            id="transcription-quality"
                            className="w-full"
                        >
                            <SelectValue>
                                {qualityOptions.find(
                                    (opt) => opt.value === transcriptionQuality,
                                )?.label || i18n("Balanced")}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {qualityOptions.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    <div>
                                        <div>{option.label}</div>
                                        <div className="text-xs text-muted-foreground">
                                            {option.description}
                                        </div>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "Balance between transcription speed and accuracy",
                        )}
                    </p>
                </div>

                <div className="flex items-center justify-between">
                    <div className="space-y-0.5 flex-1">
                        <Label
                            htmlFor="auto-generate-title"
                            className="text-base"
                        >
                            {i18n("Auto-generate titles")}
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Automatically generate descriptive titles from transcriptions using AI",
                            )}
                        </p>
                    </div>
                    <Switch
                        id="auto-generate-title"
                        checked={autoGenerateTitle}
                        onCheckedChange={(checked) => {
                            setAutoGenerateTitle(checked);
                            handleTranscriptionSettingChange({
                                autoGenerateTitle: checked,
                            });
                        }}
                        disabled={isSavingSettings}
                    />
                </div>

                {autoGenerateTitle && (
                    <div className="flex items-center justify-between pl-4 border-l-2 border-primary/20">
                        <div className="space-y-0.5 flex-1">
                            <Label
                                htmlFor="sync-title-plaud"
                                className="text-base"
                            >
                                {i18n("Sync titles to Plaud")}
                            </Label>
                            <p className="text-sm text-muted-foreground">
                                {i18n(
                                    "Update the filename in your Plaud device when titles are generated",
                                )}
                            </p>
                        </div>
                        <Switch
                            id="sync-title-plaud"
                            checked={syncTitleToPlaud}
                            onCheckedChange={(checked) => {
                                setSyncTitleToPlaud(checked);
                                handleTranscriptionSettingChange({
                                    syncTitleToPlaud: checked,
                                });
                            }}
                            disabled={isSavingSettings}
                        />
                    </div>
                )}

                {/* Hidden rather than unmounted: the list owns its state after
                    mounting, and remounting would restore the state fetched
                    when the section opened, losing edits made since. */}
                <div
                    className="pl-4 border-l-2 border-primary/20"
                    hidden={!autoGenerateTitle}
                >
                    <TemplateList
                        field="titleGenerationPrompt"
                        kind={TITLE_TEMPLATE_KIND}
                        presetCopy={titlePresetCopy}
                        initialConfig={titleTemplates}
                        heading={i18n("Title templates")}
                        promptHelp={
                            <>
                                {i18n("Use")}{" "}
                                <code className="px-1 py-0.5 bg-muted rounded">
                                    {"{transcription}"}
                                </code>{" "}
                                {i18n(
                                    "where the transcript goes. The model must reply with the title alone, as plain text. Only the beginning of a long transcript is sent.",
                                )}
                            </>
                        }
                        disabled={isSavingSettings}
                    />
                </div>

                <div className="flex items-center justify-between">
                    <div className="space-y-0.5 flex-1">
                        <Label
                            htmlFor="auto-detect-topics"
                            className="text-base"
                        >
                            {i18n("Auto-detect topics")}
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Split each new transcript into topics you can jump to. Works on transcripts with timings: Plaud's, Whisper's and speaker-labelled ones. You can also detect topics on them by hand.",
                            )}
                        </p>
                    </div>
                    <Switch
                        id="auto-detect-topics"
                        checked={autoDetectTopics}
                        onCheckedChange={(checked) =>
                            void handleAutoDetectTopicsChange(checked)
                        }
                        disabled={isSavingSettings}
                    />
                </div>

                {/* Shown with the switch off too: detecting topics by hand
                    uses the default template. */}
                <div className="pl-4 border-l-2 border-primary/20">
                    <TemplateList
                        field="topicPrompt"
                        kind={TOPIC_TEMPLATE_KIND}
                        presetCopy={topicPresetCopy}
                        initialConfig={topicTemplates}
                        heading={i18n("Topic templates")}
                        promptHelp={
                            <>
                                {i18n("Use")}{" "}
                                <code className="px-1 py-0.5 bg-muted rounded">
                                    {"{transcription}"}
                                </code>{" "}
                                {i18n(
                                    "where the transcript goes; every line of it starts with its time. Describe how to split and title the topics. The reply format is fixed by Riffado and does not need to be described.",
                                )}
                            </>
                        }
                        disabled={isSavingSettings}
                    />
                </div>
            </div>
        </div>
    );
}
