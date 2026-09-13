"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
    getAllSummaryPrompts,
    getDefaultSummaryPromptConfig,
    type SummaryPromptConfiguration,
} from "@/lib/ai/summary-presets";
import {
    addSummarizingId,
    bumpContentGeneration,
    contentGenerationFor,
    isSummarizingForView,
    rememberTranscriptionText,
    removeSummarizingId,
    shouldApplyFetchedSummary,
    shouldApplySummaryToView,
} from "@/lib/summary/job-scope";

export interface SummaryPromptOption {
    id: string;
    name: string;
    isPreset: boolean;
}

import {
    createStreamEventParser,
    type SummaryStatusProgress,
} from "@/lib/summary/progress-stream";

export interface SummaryData {
    summary: string | null;
    keyPoints: string[] | null;
    actionItems: string[] | null;
    provider?: string;
    model?: string;
    /**
     * Multi-pass provenance, absent for a single-pass summary. Returned by
     * both POST and GET, so the badge survives a reload.
     */
    multiPass?: {
        roundsRequested: number;
        passesUsed: number;
        merged: boolean;
    };
    /** Prompt id actually used server-side. Only present on POST responses. */
    promptId?: string;
    /**
     * True when the requested prompt id couldn't be resolved (e.g. a
     * custom prompt deleted from another tab) and the server fell back
     * to the default prompt instead. Only present on POST responses.
     */
    promptFallback?: boolean;
}

interface UseTranscriptionSummaryOptions {
    /** Recording id used for `/api/recordings/:id/summary` requests. */
    recordingId: string | null | undefined;
    /**
     * Latest transcription text. When this changes we drop the cached
     * summary (stale relative to the new text) and re-fetch -- the
     * server may have already auto-summarized after a re-transcribe.
     */
    transcriptionText: string | null | undefined;
}

/**
 * Shared summary state for the transcription views. Both the dashboard
 * (`TranscriptionPanel`) and the recording detail page
 * (`recordings/TranscriptionSection`) use the same endpoints with the
 * same expand/preset/optimistic-delete UX -- only the visual chrome
 * differs.
 *
 * Returns flat state + handlers; callers compose their own JSX so the
 * dashboard's shadcn `Card`/`Button` look and the recording page's
 * `Panel`/`MetalButton` look stay distinct on purpose.
 */
export function useTranscriptionSummary({
    recordingId,
    transcriptionText,
}: UseTranscriptionSummaryOptions) {
    const [summaryData, setSummaryData] = useState<SummaryData | null>(null);
    const [summarizingIds, setSummarizingIds] = useState(
        () => new Set<string>(),
    );
    const summarizingIdsRef = useRef(summarizingIds);
    const isSummarizing = isSummarizingForView(recordingId, summarizingIds);
    // Multi-pass progress for the recording currently generating, and the
    // clock beside it. Both are cleared when generation ends.
    //
    // The clock exists for the single-pass path too, which reports no
    // progress at all: a spinner that never changes is indistinguishable
    // from a hung request, which is how a slow run was first reported.
    const [summaryProgress, setSummaryProgress] =
        useState<SummaryStatusProgress | null>(null);
    const [summaryElapsedMs, setSummaryElapsedMs] = useState(0);
    const [summaryExpanded, setSummaryExpanded] = useState(true);
    const [summaryPreset, setSummaryPresetState] = useState("general");
    // Set the moment the caller (the per-recording dropdown) makes an
    // explicit choice. Guards the settings-fetch effect below from
    // clobbering that choice if the fetch resolves afterwards -- without
    // this, picking a prompt right after the page loads could get silently
    // reverted back to the saved default a moment later.
    const userSelectedPresetRef = useRef(false);
    const setSummaryPreset = useCallback((preset: string) => {
        userSelectedPresetRef.current = true;
        setSummaryPresetState(preset);
    }, []);
    const [summaryPromptOptions, setSummaryPromptOptions] = useState<
        SummaryPromptOption[]
    >(() =>
        getAllSummaryPrompts(getDefaultSummaryPromptConfig()).map((p) => ({
            id: p.id,
            name: p.name,
            isPreset: p.isPreset,
        })),
    );

    // Re-fetch trigger separate from the URL/id key so callers can
    // bump it imperatively (e.g. right after a re-transcribe finishes,
    // before the new text has propagated through props).
    const [summaryFetchKey, setSummaryFetchKey] = useState(0);

    // Load the user's saved default prompt + custom prompts once so the
    // per-recording dropdown initializes to the actual default (not a
    // hardcoded "general") and lists custom prompts alongside presets.
    useEffect(() => {
        const controller = new AbortController();
        fetch("/api/settings/user", { signal: controller.signal })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                const config = data?.summaryPrompt as
                    | SummaryPromptConfiguration
                    | null
                    | undefined;
                if (!config) return;
                if (config.selectedPrompt && !userSelectedPresetRef.current) {
                    setSummaryPresetState(config.selectedPrompt);
                }
                setSummaryPromptOptions(
                    getAllSummaryPrompts(config).map((p) => ({
                        id: p.id,
                        name: p.name,
                        isPreset: p.isPreset,
                    })),
                );
            })
            .catch(() => {});
        return () => controller.abort();
    }, []);

    const recordingIdRef = useRef(recordingId);
    const fetchGenerationRef = useRef(0);
    const contentGenByIdRef = useRef(new Map<string, number>());
    const lastTextByIdRef = useRef(
        new Map<string, string | null | undefined>(),
    );
    const getAbortRef = useRef<AbortController | null>(null);
    const summaryStartedAtRef = useRef<number | null>(null);
    if (recordingId !== recordingIdRef.current) {
        recordingIdRef.current = recordingId;
        setSummaryData(null);
    }

    // Detect when transcription text actually changes -> invalidate
    // the cached summary so the next fetch lands fresh. We compare
    // through a ref because the dashboard variant receives the text
    // via prop (parent-owned), and reading prop-vs-state isn't enough
    // to spot a stale summary.
    const transcriptionTextRef = useRef(transcriptionText);
    if (transcriptionText !== transcriptionTextRef.current) {
        transcriptionTextRef.current = transcriptionText;
        setSummaryFetchKey((k) => k + 1);
        setSummaryData(null);
    }
    if (
        recordingId &&
        rememberTranscriptionText(
            lastTextByIdRef.current,
            recordingId,
            transcriptionText,
        )
    ) {
        bumpContentGeneration(contentGenByIdRef.current, recordingId);
    }

    // Fetch when recording id changes or the re-fetch key bumps.
    // Abort on cleanup is an optimization; apply only if this fetch's
    // generation is still current so a late A GET cannot overwrite a
    // newer A GET (A → B → A) or a just-finished POST.
    // biome-ignore lint/correctness/useExhaustiveDependencies: summaryFetchKey is an intentional re-fetch trigger
    useEffect(() => {
        if (!recordingId) {
            setSummaryData(null);
            return;
        }
        const requestedId = recordingId;
        const generation = ++fetchGenerationRef.current;
        const controller = new AbortController();
        getAbortRef.current = controller;
        fetch(`/api/recordings/${requestedId}/summary`, {
            signal: controller.signal,
        })
            .then((res) => res.json())
            .then((data) => {
                if (
                    !shouldApplyFetchedSummary(
                        recordingIdRef.current,
                        requestedId,
                        fetchGenerationRef.current,
                        generation,
                    )
                ) {
                    return;
                }
                if (data.summary) {
                    setSummaryData(data);
                } else {
                    setSummaryData(null);
                }
            })
            .catch(() => {});
        return () => {
            controller.abort();
            if (getAbortRef.current === controller) {
                getAbortRef.current = null;
            }
        };
    }, [recordingId, summaryFetchKey]);

    const handleSummarize = useCallback(async () => {
        if (!recordingId) return;
        if (summarizingIdsRef.current.has(recordingId)) return;
        const targetId = recordingId;
        const postGeneration = contentGenerationFor(
            contentGenByIdRef.current,
            targetId,
        );
        const postIsCurrent = () =>
            shouldApplyFetchedSummary(
                recordingIdRef.current,
                targetId,
                contentGenerationFor(contentGenByIdRef.current, targetId),
                postGeneration,
            );
        getAbortRef.current?.abort();
        fetchGenerationRef.current += 1;
        summarizingIdsRef.current = addSummarizingId(
            summarizingIdsRef.current,
            targetId,
        );
        setSummarizingIds(summarizingIdsRef.current);
        setSummaryProgress(null);
        setSummaryElapsedMs(0);
        summaryStartedAtRef.current = Date.now();

        const applyResult = (data: SummaryData) => {
            if (!postIsCurrent()) return;
            fetchGenerationRef.current += 1;
            setSummaryData(data);
            if (data.promptFallback) {
                toast.warning(
                    "Selected summary prompt is no longer available -- used your default prompt instead.",
                );
            } else {
                toast.success("Summary generated");
            }
        };

        try {
            const response = await fetch(
                `/api/recordings/${targetId}/summary`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        // Opt in to progress. A server that predates streaming
                        // ignores this and answers with JSON, which the branch
                        // below still handles.
                        Accept: "text/event-stream, application/json",
                    },
                    body: JSON.stringify({ preset: summaryPreset }),
                },
            );

            const isStream = (
                response.headers.get("content-type") ?? ""
            ).includes("text/event-stream");

            if (isStream && response.body) {
                // A streamed response is 200 before the work starts, so a
                // failure arrives as an event rather than a status code.
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const parse = createStreamEventParser();
                let settled = false;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    for (const event of parse(
                        decoder.decode(value, { stream: true }),
                    )) {
                        if (event.type === "progress") {
                            if (!postIsCurrent()) continue;
                            setSummaryProgress({
                                phase: event.phase,
                                completed: event.completed,
                                total: event.total,
                            });
                        } else if (event.type === "result") {
                            settled = true;
                            applyResult(event.result as SummaryData);
                        } else if (event.type === "error") {
                            settled = true;
                            if (postIsCurrent()) {
                                toast.error(
                                    event.error || "Summary generation failed",
                                );
                            }
                        }
                    }
                }

                // The stream ended without saying how it went -- a dropped
                // connection or a killed process. Silence would leave the
                // spinner's disappearance as the only signal.
                if (!settled && postIsCurrent()) {
                    toast.error("Summary generation was interrupted");
                }
            } else if (response.ok) {
                applyResult((await response.json()) as SummaryData);
            } else {
                const error = await response.json().catch(() => ({}));
                if (postIsCurrent()) {
                    toast.error(error.error || "Summary generation failed");
                }
            }
        } catch {
            if (postIsCurrent()) {
                toast.error("Failed to generate summary");
            }
        } finally {
            summarizingIdsRef.current = removeSummarizingId(
                summarizingIdsRef.current,
                targetId,
            );
            setSummarizingIds(summarizingIdsRef.current);
            summaryStartedAtRef.current = null;
            setSummaryProgress(null);
            setSummaryElapsedMs(0);
        }
    }, [recordingId, summaryPreset]);

    const handleDeleteSummary = useCallback(async () => {
        if (!recordingId) return;
        const targetId = recordingId;
        // Optimistic delete -- the summary disappears immediately and
        // only comes back if the server rejects the request.
        const previous = summaryData;
        setSummaryData(null);
        const deleteIsCurrent = () =>
            shouldApplySummaryToView(recordingIdRef.current, targetId);

        try {
            const response = await fetch(
                `/api/recordings/${targetId}/summary`,
                { method: "DELETE" },
            );
            if (response.ok) {
                if (deleteIsCurrent()) {
                    toast.success("Summary deleted");
                }
            } else {
                if (deleteIsCurrent()) {
                    setSummaryData(previous);
                    toast.error("Failed to delete summary");
                }
            }
        } catch {
            if (deleteIsCurrent()) {
                setSummaryData(previous);
                toast.error("Failed to delete summary");
            }
        }
    }, [recordingId, summaryData]);

    /**
     * Imperative re-fetch trigger. Use after a re-transcribe call
     * where the server may already have re-summarized -- bumping the
     * key forces a GET without changing recordingId.
     */
    // One interval for the whole hook rather than one per component that
    // renders the clock, and only while something is actually generating.
    useEffect(() => {
        if (!isSummarizing) return;
        const tick = () => {
            const startedAt = summaryStartedAtRef.current;
            if (startedAt != null) setSummaryElapsedMs(Date.now() - startedAt);
        };
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [isSummarizing]);

    const refetchSummary = useCallback(() => {
        const id = recordingIdRef.current;
        if (id) {
            bumpContentGeneration(contentGenByIdRef.current, id);
        }
        setSummaryData(null);
        setSummaryFetchKey((k) => k + 1);
    }, []);

    return {
        summaryData,
        isSummarizing,
        summaryProgress,
        summaryElapsedMs,
        summaryExpanded,
        setSummaryExpanded,
        summaryPreset,
        setSummaryPreset,
        summaryPromptOptions,
        handleSummarize,
        handleDeleteSummary,
        refetchSummary,
    };
}
