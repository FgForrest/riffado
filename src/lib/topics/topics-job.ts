/**
 * Queueing topic detection. Kept light for the same reason as
 * `summary-job.ts`: the route and the transcription pipeline import this;
 * only the worker registration imports the handler and its provider client.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { type EnqueueJobResult, enqueueJob } from "@/db/queries/async-jobs";
import { userSettings } from "@/db/schema";
import { env } from "@/lib/env";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { recordingJobSubject } from "@/lib/sharing/view";
import type { TopicSource } from "./generate-topics";

export const TOPICS_JOB_KIND = "topics";

/** As summaries: a click outranks a sync's backlog. */
export const TOPICS_PRIORITY_MANUAL = 10;
export const TOPICS_PRIORITY_AUTO = 0;

export const TOPICS_MAX_ATTEMPTS = 3;

/** One request per 40k characters of transcript; ten minutes is generous. */
export const TOPICS_TIMEOUT_MS = 10 * 60 * 1000;

export interface TopicsJobPayload {
    recordingId: string;
    source: TopicSource;
    trigger: "manual" | "auto";
}

export function parseTopicsJobPayload(
    raw: Record<string, unknown>,
): TopicsJobPayload {
    const recordingId = raw.recordingId;
    if (typeof recordingId !== "string" || recordingId.length === 0) {
        throw new InvalidJobPayloadError(
            TOPICS_JOB_KIND,
            "recordingId must be a non-empty string",
        );
    }
    if (raw.source !== "plaud" && raw.source !== "riffado") {
        throw new InvalidJobPayloadError(
            TOPICS_JOB_KIND,
            'source must be "plaud" or "riffado"',
        );
    }
    return {
        recordingId,
        source: raw.source,
        trigger: raw.trigger === "manual" ? "manual" : "auto",
    };
}

/**
 * Queue topic detection for one transcript of a recording, or return the
 * job already queued for the recording.
 *
 * The dedupe is per recording, not per transcript: a click on the Plaud
 * transcript while its Custom transcript is being processed returns that
 * job. The route compares the payload's source and says so rather than
 * reporting the other transcript's topics.
 */
export async function enqueueTopicsJob(input: {
    userId: string;
    recordingId: string;
    source: TopicSource;
    trigger: "manual" | "auto";
}): Promise<EnqueueJobResult> {
    const enqueued = await enqueueJob({
        userId: input.userId,
        kind: TOPICS_JOB_KIND,
        subjectId: recordingJobSubject(input.recordingId, "private"),
        priority:
            input.trigger === "manual"
                ? TOPICS_PRIORITY_MANUAL
                : TOPICS_PRIORITY_AUTO,
        maxAttempts: TOPICS_MAX_ATTEMPTS,
        payload: {
            recordingId: input.recordingId,
            source: input.source,
            trigger: input.trigger,
        },
    });
    if (enqueued.created) nudge();
    return enqueued;
}

/**
 * Queue topics after a transcript with timings was written, when the user
 * asked for that. Never throws: the transcript is what matters to whoever
 * wrote it, and topics can always be detected by hand.
 */
export async function queueAutoTopics(
    userId: string,
    recordingId: string,
    source: TopicSource,
): Promise<void> {
    try {
        const [settings] = await db
            .select({ autoDetectTopics: userSettings.autoDetectTopics })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);
        if (!settings?.autoDetectTopics) return;

        // Same ceiling as auto-summary, in its own bucket: a sync replaying
        // many recordings must not run up a provider bill unattended.
        const rateLimit = await consumeRateLimitBucket(
            `auto-topics:user:${userId}`,
            {
                limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
                windowMs: 60 * 60 * 1000,
            },
        );
        if (!rateLimit.allowed) {
            console.warn(
                `Auto-topics rate limit hit for user ${userId} (recording ${recordingId})`,
            );
            return;
        }
        await enqueueTopicsJob({
            userId,
            recordingId,
            source,
            trigger: "auto",
        });
    } catch (error) {
        console.error(
            `Could not queue topics for recording ${recordingId}:`,
            error,
        );
    }
}
