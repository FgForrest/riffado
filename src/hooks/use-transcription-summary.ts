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

export type SummarySource = "plaud" | "riffado";

import {
    followJob,
    type JobProgressSnapshot,
    type JobSnapshot,
} from "@/lib/jobs/client";
import {
    createStreamEventParser,
    type SummaryStatusProgress,
} from "@/lib/summary/progress-stream";

/**
 * A job's stored progress, narrowed to what the status line can render.
 *
 * The job row's `progress` is deliberately loose -- it is shared by every job
 * kind -- so anything that does not look like multi-pass progress is dropped
 * rather than rendered as `NaN/NaN`.
 */
function toSummaryProgress(
    raw: JobProgressSnapshot | null | undefined,
): SummaryStatusProgress | null {
    if (!raw) return null;
    if (raw.phase !== "passes" && raw.phase !== "merging") return null;
    const completed = Number(raw.completed);
    const total = Number(raw.total);
    if (!Number.isFinite(completed) || !Number.isFinite(total)) return null;
    return { phase: raw.phase, completed, total };
}

export interface SummaryData {
    summary: string | null;
    keyPoints: string[] | null;
    actionItems: string[] | null;
    source: SummarySource;
    transcriptionId?: string | null;
    availableSources?: SummarySource[];
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
    /**
     * Present on GET when a summary job for this recording is queued or
     * running -- started in another tab, by an automatic run after a sync, or
     * picked back up by a worker after a restart. Lets a freshly opened page
     * show that work is in progress instead of an empty panel.
     */
    activeJob?: {
        jobId: string;
        status: "pending" | "processing" | "completed" | "failed";
        progress: JobProgressSnapshot | null;
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
    summarySource?: SummarySource;
    /**
     * Latest transcription text. When this changes we drop the cached
     * summary (stale relative to the new text) and re-fetch -- the
     * server may have already auto-summarized after a re-transcribe.
     */
    transcriptionText: string | null | undefined;
}

/**
 * Shared summary state for the transcription views. The dashboard and the
 * recording detail page both render `TranscriptionPanel`, which is the only
 * consumer.
 *
 * Returns flat state + handlers; callers compose their own JSX so the
 * dashboard's shadcn `Card`/`Button` look and the recording page's
 * `Panel`/`MetalButton` look stay distinct on purpose.
 */
export function useTranscriptionSummary({
    recordingId,
    summarySource = "riffado",
    transcriptionText,
}: UseTranscriptionSummaryOptions) {
    const [summaryData, setSummaryData] = useState<SummaryData | null>(null);
    const [availableSummarySources, setAvailableSummarySources] = useState<
        SummarySource[]
    >([]);
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
    const summarySourceRef = useRef(summarySource);
    const fetchGenerationRef = useRef(0);
    const contentGenByIdRef = useRef(new Map<string, number>());
    const lastTextByIdRef = useRef(
        new Map<string, string | null | undefined>(),
    );
    const getAbortRef = useRef<AbortController | null>(null);
    const summaryStartedAtRef = useRef<number | null>(null);
    // Stops job polling when the hook goes away. Without it, a component
    // unmounted while a summary is running would keep requesting the job
    // until it settled -- for minutes, on a page nobody is looking at.
    const followAbortRef = useRef<AbortController | null>(null);
    if (followAbortRef.current === null) {
        followAbortRef.current = new AbortController();
    }
    useEffect(
        () => () => {
            followAbortRef.current?.abort();
        },
        [],
    );
    if (recordingId !== recordingIdRef.current) {
        recordingIdRef.current = recordingId;
        setSummaryData(null);
        setAvailableSummarySources([]);
    }
    if (summarySource !== summarySourceRef.current) {
        summarySourceRef.current = summarySource;
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

    /**
     * Adopt a summary job that is already running.
     *
     * The job may have been started by another tab, by an automatic run after
     * a sync, or by this very page before a deploy replaced the container
     * underneath it. In all three cases the alternative is an idle-looking
     * panel while work the user is waiting for happens invisibly.
     */
    const attachToActiveJob = useCallback(
        async (
            targetId: string,
            job: NonNullable<SummaryData["activeJob"]>,
        ) => {
            if (summarizingIdsRef.current.has(targetId)) return;
            const generation = contentGenerationFor(
                contentGenByIdRef.current,
                targetId,
            );
            const isCurrent = () =>
                summarySourceRef.current === "riffado" &&
                shouldApplyFetchedSummary(
                    recordingIdRef.current,
                    targetId,
                    contentGenerationFor(contentGenByIdRef.current, targetId),
                    generation,
                );

            summarizingIdsRef.current = addSummarizingId(
                summarizingIdsRef.current,
                targetId,
            );
            setSummarizingIds(summarizingIdsRef.current);
            setSummaryProgress(toSummaryProgress(job.progress));
            setSummaryElapsedMs(0);
            // The clock starts now rather than when the job did. Showing a
            // duration this page did not witness would be a guess: the job
            // row records when it was created, not how long the user has been
            // waiting, and those differ by however long it sat in the queue.
            summaryStartedAtRef.current = Date.now();

            try {
                const snapshot: JobSnapshot | null = await followJob(
                    job.jobId,
                    {
                        signal: followAbortRef.current?.signal,
                        onProgress: (raw) => {
                            if (!isCurrent()) return;
                            const narrowed = toSummaryProgress(raw);
                            if (narrowed) setSummaryProgress(narrowed);
                        },
                    },
                );
                if (!snapshot || !isCurrent()) return;
                if (snapshot.status === "completed") {
                    const response = await fetch(
                        `/api/recordings/${targetId}/summary?source=riffado`,
                    );
                    if (!response.ok) return;
                    const data = (await response.json()) as SummaryData;
                    setAvailableSummarySources(data.availableSources ?? []);
                    if (data.summary && isCurrent()) {
                        fetchGenerationRef.current += 1;
                        setSummaryData(data);
                        toast.success("Summary generated");
                    }
                } else if (isCurrent()) {
                    toast.error(snapshot.error || "Summary generation failed");
                }
            } catch {
                // Nothing to report: this client only ever observed the job,
                // and an observation that fails says nothing about the work.
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
        },
        [],
    );

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
        const requestedSource = summarySource;
        fetch(
            `/api/recordings/${requestedId}/summary?source=${requestedSource}`,
            {
                signal: controller.signal,
            },
        )
            .then((res) => res.json())
            .then((data) => {
                if (
                    !shouldApplyFetchedSummary(
                        recordingIdRef.current,
                        requestedId,
                        fetchGenerationRef.current,
                        generation,
                    ) ||
                    summarySourceRef.current !== requestedSource
                ) {
                    return;
                }
                setAvailableSummarySources(
                    (data as SummaryData).availableSources ?? [],
                );
                if (data.summary) {
                    setSummaryData(data);
                } else {
                    setSummaryData(null);
                }
                const active = (data as SummaryData).activeJob;
                if (
                    active &&
                    (active.status === "pending" ||
                        active.status === "processing")
                ) {
                    void attachToActiveJob(requestedId, active);
                }
            })
            .catch(() => {});
        return () => {
            controller.abort();
            if (getAbortRef.current === controller) {
                getAbortRef.current = null;
            }
        };
    }, [recordingId, summarySource, summaryFetchKey, attachToActiveJob]);

    const handleSummarize = useCallback(async () => {
        if (!recordingId) return;
        if (summarySource !== "riffado") return;
        if (summarizingIdsRef.current.has(recordingId)) return;
        const targetId = recordingId;
        const postGeneration = contentGenerationFor(
            contentGenByIdRef.current,
            targetId,
        );
        const postIsCurrent = () =>
            summarySourceRef.current === "riffado" &&
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
            setAvailableSummarySources((current) =>
                current.includes("riffado") ? current : [...current, "riffado"],
            );
            if (data.promptFallback) {
                toast.warning(
                    "Selected summary prompt is no longer available -- used your default prompt instead.",
                );
            } else {
                toast.success("Summary generated");
            }
        };

        /**
         * Fetch a summary the server has already written.
         *
         * Needed when a job completes somewhere this client was not watching:
         * the job itself records only provenance, so the text has to be read
         * back from the recording. Returns whether a summary was found.
         */
        const applyStoredSummary = async (): Promise<boolean> => {
            try {
                const response = await fetch(
                    `/api/recordings/${targetId}/summary?source=riffado`,
                );
                if (!response.ok) return false;
                const data = (await response.json()) as SummaryData;
                if (!data.summary) return false;
                applyResult(data);
                return true;
            } catch {
                return false;
            }
        };

        /**
         * Follow a job whose stream this client lost, and report how it ended.
         *
         * Returns false only when the outcome is genuinely unknown -- the job
         * could not be found, or following was abandoned -- so the caller can
         * fall back to saying so rather than inventing a verdict.
         */
        const followSummaryJob = async (jobId: string): Promise<boolean> => {
            const snapshot = await followJob(jobId, {
                signal: followAbortRef.current?.signal,
                onProgress: (raw) => {
                    if (!postIsCurrent()) return;
                    const narrowed = toSummaryProgress(raw);
                    if (narrowed) setSummaryProgress(narrowed);
                },
            });
            if (!snapshot) return false;
            if (snapshot.status === "completed") {
                if (await applyStoredSummary()) return true;
                if (postIsCurrent()) {
                    toast.error(
                        "The summary finished but could not be loaded. Reload to try again.",
                    );
                }
                return true;
            }
            if (postIsCurrent()) {
                toast.error(snapshot.error || "Summary generation failed");
            }
            return true;
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
                let jobId: string | null = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    for (const event of parse(
                        decoder.decode(value, { stream: true }),
                    )) {
                        if (event.type === "queued") {
                            // Kept so the work can be followed if this
                            // connection does not survive it.
                            jobId = event.jobId;
                        } else if (event.type === "progress") {
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

                // The stream ended without saying how it went. Since the work
                // belongs to a job rather than to this request, that almost
                // always means the connection died and the summary did not --
                // a deploy, a proxy timeout, a laptop lid. Go and ask.
                if (!settled && jobId) {
                    settled = await followSummaryJob(jobId);
                }

                // No job id, or the job itself could not be found: now the
                // silence really is all there is to report.
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
    }, [recordingId, summaryPreset, summarySource]);

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
                `/api/recordings/${targetId}/summary?source=${summarySource}`,
                { method: "DELETE" },
            );
            if (response.ok) {
                if (deleteIsCurrent()) {
                    toast.success("Summary deleted");
                    setAvailableSummarySources((current) =>
                        current.filter((source) => source !== summarySource),
                    );
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
    }, [recordingId, summaryData, summarySource]);

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
        availableSummarySources,
        isSummarizing: summarySource === "riffado" && isSummarizing,
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
