"use client";

import { useExtracted } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-errors";
import { followJob } from "@/lib/jobs/client";
import type { TranscriptTopic } from "@/lib/topics/timeline";

/** How often a job that outlived its request is checked on. */
const POLL_MS = 3_000;
/** Past the job's own ceiling; the job keeps running if we stop watching. */
const POLL_LIMIT_MS = 12 * 60 * 1000;

type TopicSource = "plaud" | "riffado";

function isTopicSource(source: string | undefined): source is TopicSource {
    return source === "plaud" || source === "riffado";
}

/**
 * Topics of one transcript, and detecting them on demand.
 *
 * `stored` is what the page was rendered with. Topics detected here replace
 * it for as long as the panel lives; the page reads them from the row on its
 * next render.
 *
 * When `enabled`, a topics job already running for the transcript -- queued
 * automatically, or by a click before the page was reloaded -- is picked up
 * on mount and followed as if this page had started it. Without that the
 * button looks idle while the job runs, and a click only joins it.
 */
export function useTranscriptTopics(
    recordingId: string,
    source: string | undefined,
    stored: TranscriptTopic[] | null | undefined,
    enabled: boolean,
) {
    const i18n = useExtracted();
    // `i18n` is a new function every render. The callbacks the mount check
    // depends on read these through a ref, so they keep their identity.
    const messagesRef = useRef({ failed: "", detected: "", slow: "" });
    messagesRef.current = {
        failed: i18n("Topic detection failed"),
        detected: i18n("Topics detected"),
        slow: i18n(
            "Topic detection is taking unusually long. It continues in the background.",
        ),
    };
    const [detected, setDetected] = useState<
        Partial<Record<string, TranscriptTopic[]>>
    >({});
    const [detecting, setDetecting] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => () => abortRef.current?.abort(), []);

    const topics = source ? (detected[source] ?? stored ?? null) : null;

    /** Stops whatever this hook is following and starts over. */
    const restart = useCallback((topicSource: TopicSource) => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setDetecting(topicSource);
        return controller;
    }, []);

    /**
     * Done following. `abortRef` holds only work still in progress, which is
     * how the mount check knows a click already owns the job.
     */
    const release = useCallback((controller: AbortController) => {
        if (abortRef.current !== controller) return;
        abortRef.current = null;
        setDetecting(null);
    }, []);

    /** Reads back the topics a completed job stored, and shows them. */
    const showStored = useCallback(
        async (topicSource: TopicSource, signal: AbortSignal) => {
            const response = await fetch(
                `/api/recordings/${recordingId}/topics?source=${topicSource}`,
                { signal },
            );
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        messagesRef.current.failed,
                    ),
                );
                return;
            }
            const next: TranscriptTopic[] =
                (await response.json()).topics ?? [];
            setDetected((current) => ({ ...current, [topicSource]: next }));
            toast.success(messagesRef.current.detected);
        },
        [recordingId],
    );

    /** Follows a job to its end and says how it went. */
    const settle = useCallback(
        async (
            topicSource: TopicSource,
            jobId: string,
            signal: AbortSignal,
        ) => {
            const deadline = new AbortController();
            const stop = () => deadline.abort();
            signal.addEventListener("abort", stop);
            const timer = setTimeout(stop, POLL_LIMIT_MS);
            try {
                const job = await followJob(jobId, {
                    pollMs: POLL_MS,
                    signal: deadline.signal,
                });
                if (signal.aborted) return;
                if (!job) {
                    // Null is a timeout or a job gone from the queue; only
                    // the first says anything worth telling.
                    if (deadline.signal.aborted) {
                        toast.error(messagesRef.current.slow);
                    }
                    return;
                }
                if (job.status === "failed") {
                    toast.error(job.error || messagesRef.current.failed);
                    return;
                }
                await showStored(topicSource, signal);
            } finally {
                clearTimeout(timer);
                signal.removeEventListener("abort", stop);
            }
        },
        [showStored],
    );

    useEffect(() => {
        if (!enabled || !isTopicSource(source)) return;
        const topicSource = source;
        const probe = new AbortController();
        let following: AbortController | null = null;
        (async () => {
            const response = await fetch(
                `/api/recordings/${recordingId}/topics?source=${topicSource}`,
                { signal: probe.signal },
            );
            if (!response.ok || probe.signal.aborted) return;
            const { jobId } = (await response.json()) as {
                jobId?: string | null;
            };
            // A click that came first owns the job already.
            if (!jobId || probe.signal.aborted || abortRef.current) return;
            following = restart(topicSource);
            try {
                await settle(topicSource, jobId, following.signal);
            } finally {
                release(following);
            }
        })().catch((error) => {
            if (probe.signal.aborted || following?.signal.aborted) return;
            console.error("Could not check for topic detection:", error);
            if (following) release(following);
        });
        return () => {
            probe.abort();
            following?.abort();
        };
    }, [recordingId, source, enabled, restart, release, settle]);

    const detect = useCallback(async () => {
        if (!isTopicSource(source)) return;
        const topicSource = source;
        const controller = restart(topicSource);
        const { signal } = controller;
        const { failed, detected } = messagesRef.current;

        try {
            const response = await fetch(
                `/api/recordings/${recordingId}/topics?source=${topicSource}`,
                { method: "POST", signal },
            );
            if (!response.ok) {
                toast.error(await getApiErrorMessage(response, failed));
                return;
            }
            const body = await response.json();
            if (response.status !== 202) {
                const next: TranscriptTopic[] = body.topics ?? [];
                setDetected((current) => ({ ...current, [topicSource]: next }));
                toast.success(detected);
                return;
            }
            // The job outlived the request; follow it until it settles.
            await settle(topicSource, body.jobId, signal);
        } catch (error) {
            if (signal.aborted) return;
            console.error("Topic detection failed:", error);
            toast.error(failed);
        } finally {
            release(controller);
        }
    }, [recordingId, source, restart, release, settle]);

    return {
        topics,
        detecting: source !== undefined && detecting === source,
        detect,
    };
}
