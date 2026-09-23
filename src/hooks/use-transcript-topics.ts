"use client";

import { useExtracted } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-errors";
import type { TranscriptTopic } from "@/lib/topics/timeline";

/** How often a job that outlived its request is checked on. */
const POLL_MS = 3_000;
/** Past the job's own ceiling; the job keeps running if we stop watching. */
const POLL_LIMIT_MS = 12 * 60 * 1000;

type TopicSource = "plaud" | "riffado";

/**
 * Topics of one transcript, and detecting them on demand.
 *
 * `stored` is what the page was rendered with. Topics detected here replace
 * it for as long as the panel lives; the page reads them from the row on its
 * next render.
 */
export function useTranscriptTopics(
    recordingId: string,
    source: string | undefined,
    stored: TranscriptTopic[] | null | undefined,
) {
    const i18n = useExtracted();
    const [detected, setDetected] = useState<
        Partial<Record<string, TranscriptTopic[]>>
    >({});
    const [detecting, setDetecting] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => () => abortRef.current?.abort(), []);

    const topics = source ? (detected[source] ?? stored ?? null) : null;

    const detect = useCallback(async () => {
        if (source !== "plaud" && source !== "riffado") return;
        const topicSource: TopicSource = source;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const { signal } = controller;
        const topicsUrl = `/api/recordings/${recordingId}/topics?source=${topicSource}`;
        const failed = i18n("Topic detection failed");

        const finish = (next: TranscriptTopic[]) => {
            setDetected((current) => ({ ...current, [topicSource]: next }));
            toast.success(i18n("Topics detected"));
        };

        setDetecting(topicSource);
        try {
            const response = await fetch(topicsUrl, { method: "POST", signal });
            if (!response.ok) {
                toast.error(await getApiErrorMessage(response, failed));
                return;
            }
            const body = await response.json();
            if (response.status !== 202) {
                finish(body.topics ?? []);
                return;
            }

            // The job outlived the request; follow it until it settles.
            const deadline = Date.now() + POLL_LIMIT_MS;
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
                if (signal.aborted) return;
                const jobResponse = await fetch(`/api/jobs/${body.jobId}`, {
                    signal,
                });
                if (!jobResponse.ok) continue;
                const job = await jobResponse.json();
                if (job.status === "failed") {
                    toast.error(job.error || failed);
                    return;
                }
                if (job.status === "completed") {
                    const stored = await fetch(topicsUrl, { signal });
                    if (!stored.ok) {
                        toast.error(await getApiErrorMessage(stored, failed));
                        return;
                    }
                    finish((await stored.json()).topics ?? []);
                    return;
                }
            }
            toast.error(
                i18n(
                    "Topic detection is taking unusually long. It continues in the background.",
                ),
            );
        } catch (error) {
            if (signal.aborted) return;
            console.error("Topic detection failed:", error);
            toast.error(failed);
        } finally {
            if (!signal.aborted) setDetecting(null);
        }
    }, [recordingId, source, i18n]);

    return {
        topics,
        detecting: source !== undefined && detecting === source,
        detect,
    };
}
