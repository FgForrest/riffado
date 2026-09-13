/**
 * Queueing a summary.
 *
 * Deliberately light. The handler that actually runs one lives next door in
 * `summary-job-handler.ts`, because it reaches for the OpenAI client, the
 * encryption layer and the webhook emitter -- none of which a caller that
 * merely wants to say "please summarise this" should have to load. The API
 * route and the transcription pipeline import this file; only the worker's
 * registration imports the other.
 *
 * The constants live here rather than with the handler for the same reason:
 * the route needs the timeout to size its own wait, and should not pull a
 * provider client in to read a number.
 */

import { type EnqueueJobResult, enqueueJob } from "@/db/queries/async-jobs";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";

export const SUMMARY_JOB_KIND = "summary";

/**
 * A summary someone is watching outranks one a sync started.
 *
 * Without this, clicking "Generate summary" during a sync means queueing
 * behind however many recordings that sync is auto-summarising -- the user is
 * sitting in front of a spinner while the queue works through a backlog they
 * cannot see.
 */
export const SUMMARY_PRIORITY_MANUAL = 10;
export const SUMMARY_PRIORITY_AUTO = 0;

/**
 * Attempts per job.
 *
 * Three, matching the export worker. Each attempt is a full multi-pass fan-out
 * in the worst case, so this is a real cost ceiling and not just a count: the
 * retries are there for a provider blip or an interrupted deploy, not to grind
 * against a provider that is genuinely down.
 */
export const SUMMARY_MAX_ATTEMPTS = 3;

/**
 * Ceiling on one attempt.
 *
 * Sized against the slow case rather than the typical one: five passes plus a
 * merge, against an agent bridge whose own `BRIDGE_TIMEOUT_MS` can be ten
 * minutes, is well past anything an HTTP request would tolerate -- which is
 * the point of moving it off the request in the first place.
 */
export const SUMMARY_TIMEOUT_MS = 30 * 60 * 1000;

export interface SummaryJobPayload {
    recordingId: string;
    presetId?: string;
    trigger: "manual" | "auto";
}

/**
 * Validate a stored payload.
 *
 * Rejections are permanent by the worker's rules, which is right: a payload
 * that does not parse now will not parse in thirty seconds either.
 */
export function parseSummaryJobPayload(
    raw: Record<string, unknown>,
): SummaryJobPayload {
    const recordingId = raw.recordingId;
    if (typeof recordingId !== "string" || recordingId.length === 0) {
        throw new InvalidJobPayloadError(
            SUMMARY_JOB_KIND,
            "recordingId must be a non-empty string",
        );
    }
    const presetId = raw.presetId;
    if (presetId !== undefined && typeof presetId !== "string") {
        throw new InvalidJobPayloadError(
            SUMMARY_JOB_KIND,
            "presetId must be a string when present",
        );
    }
    // An unrecognised trigger is treated as automatic rather than rejected:
    // the field only selects analytics labelling and the multi-pass auto
    // opt-in, and the conservative reading of an unknown value is the one
    // that does not spend extra passes.
    const trigger = raw.trigger === "manual" ? "manual" : "auto";
    return { recordingId, presetId: presetId ?? undefined, trigger };
}

export interface EnqueueSummaryInput {
    userId: string;
    recordingId: string;
    presetId?: string;
    trigger: "manual" | "auto";
}

/**
 * Queue a summary, or return the job already queued for this recording.
 *
 * The dedupe is the partial unique index on `(kind, subject_id)`, so a
 * double-clicked button, two browser tabs, and a manual click racing an
 * auto-summary all converge on one job rather than paying for the work twice.
 */
export async function enqueueSummaryJob(
    input: EnqueueSummaryInput,
): Promise<EnqueueJobResult> {
    const enqueued = await enqueueJob({
        userId: input.userId,
        kind: SUMMARY_JOB_KIND,
        subjectId: input.recordingId,
        priority:
            input.trigger === "manual"
                ? SUMMARY_PRIORITY_MANUAL
                : SUMMARY_PRIORITY_AUTO,
        maxAttempts: SUMMARY_MAX_ATTEMPTS,
        payload: {
            recordingId: input.recordingId,
            ...(input.presetId ? { presetId: input.presetId } : {}),
            trigger: input.trigger,
        },
    });
    // Start it now rather than at the next sweep, when this process is the
    // one that will run it. Costs nothing when it is not.
    if (enqueued.created) nudge();
    return enqueued;
}
