"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { followJob } from "@/lib/jobs/client";
import {
    type RecordingView,
    recordingJobSubject,
    withRecordingView,
} from "@/lib/sharing/view";

type ActionKind = "transcribing" | "summarizing";

interface Options {
    /** Called after a successful transcribe so the parent can refresh data. */
    onTranscribeComplete: () => void;
}

/**
 * Per-recording action state for transcription and summarization.
 *
 * A standalone "isTranscribing" boolean races when two transcribes run
 * concurrently -- each request's `finally` would flip it back to false
 * while another was still pending. The per-id map below is the source
 * of truth; callers derive `anyTranscribing` / `isCurrentTranscribing`
 * etc. from `inFlightActions`.
 *
 * `markAction` is exposed so future summarize handlers can use the
 * same map without duplicating the Map-update plumbing.
 *
 * Entries are keyed by `recordingJobSubject(id, view)`: the private and the
 * Organization view of one recording transcribe independently.
 */
export function useTranscribeQueue({ onTranscribeComplete }: Options) {
    const [inFlightActions, setInFlightActions] = useState<
        Map<string, ActionKind>
    >(new Map());
    const activeIdsRef = useRef(new Set<string>());
    const abortRef = useRef<AbortController | null>(null);
    if (abortRef.current === null) abortRef.current = new AbortController();

    useEffect(
        () => () => {
            abortRef.current?.abort();
        },
        [],
    );

    const markAction = useCallback((id: string, kind: ActionKind | null) => {
        setInFlightActions((prev) => {
            const next = new Map(prev);
            if (kind === null) next.delete(id);
            else next.set(id, kind);
            return next;
        });
    }, []);

    const beginTracking = useCallback(
        (id: string): boolean => {
            if (activeIdsRef.current.has(id)) return false;
            activeIdsRef.current.add(id);
            markAction(id, "transcribing");
            return true;
        },
        [markAction],
    );

    const finishTracking = useCallback(
        (id: string) => {
            activeIdsRef.current.delete(id);
            markAction(id, null);
        },
        [markAction],
    );

    const followTranscription = useCallback(
        async (id: string, jobId: string) => {
            try {
                const snapshot = await followJob(jobId, {
                    signal: abortRef.current?.signal,
                });
                if (!snapshot) return;
                if (snapshot.status === "completed") {
                    toast.success("Transcription complete");
                    onTranscribeComplete();
                } else {
                    toast.error(snapshot.error || "Transcription failed");
                }
            } finally {
                finishTracking(id);
            }
        },
        [finishTracking, onTranscribeComplete],
    );

    /**
     * Trigger transcription for a specific recording id. Used by:
     *   - the per-recording "Transcribe" button in TranscriptionPanel
     *     (via a wrapper that targets the currently selected recording
     *     for backwards compatibility), and
     *   - the command palette's per-row "Transcribe X" quick actions,
     *     which need to dispatch against an arbitrary recording without
     *     having to first change the selection.
     */
    const transcribeById = useCallback(
        async (
            id: string,
            attributionSource?: string,
            view: RecordingView = "private",
        ) => {
            const key = recordingJobSubject(id, view);
            if (!beginTracking(key)) return;
            try {
                const response = await fetch(
                    withRecordingView(`/api/recordings/${id}/transcribe`, view),
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ attributionSource }),
                    },
                );
                if (response.ok) {
                    const data = (await response.json()) as {
                        jobId?: string;
                    };
                    if (!data.jobId) {
                        throw new Error("Transcription job was not returned");
                    }
                    await followTranscription(key, data.jobId);
                    return;
                } else {
                    const error = await response.json();
                    toast.error(error.error || "Transcription failed");
                }
            } catch {
                toast.error("Failed to transcribe recording");
            } finally {
                finishTracking(key);
            }
        },
        [beginTracking, finishTracking, followTranscription],
    );

    const observeTranscriptionById = useCallback(
        async (id: string, view: RecordingView = "private") => {
            const key = recordingJobSubject(id, view);
            if (activeIdsRef.current.has(key)) return;
            try {
                const response = await fetch(
                    withRecordingView(`/api/recordings/${id}/transcribe`, view),
                    { signal: abortRef.current?.signal },
                );
                if (!response.ok) return;
                const data = (await response.json()) as {
                    activeJob?: { jobId: string };
                };
                if (!data.activeJob || !beginTracking(key)) return;
                await followTranscription(key, data.activeJob.jobId);
            } catch {
                // Observation is best-effort. The durable job continues even
                // when this page cannot reach its status endpoint.
            }
        },
        [beginTracking, followTranscription],
    );

    return {
        inFlightActions,
        markAction,
        observeTranscriptionById,
        transcribeById,
    };
}
