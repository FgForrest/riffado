/**
 * After the corrections a model reads changed outside a transcription (a
 * finished review, an undo), the summary made from the old reading is
 * stale (Task 5.6). With auto-summarize on it is made again, as after a
 * transcription (same hourly cap); with it off, the summary says it may be
 * stale (`stale` on its GET). A summary made before corrections existed
 * (no fingerprint) is left alone, as is the Organization view, which is
 * never summarized automatically.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiEnhancements, userSettings } from "@/db/schema";
import { env } from "@/lib/env";
import { llmRendering } from "@/lib/learn/llm-input";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import type { RecordingView } from "@/lib/sharing/view";
import { enqueueSummaryJob } from "@/lib/summary/summary-job";

/**
 * Whether the recording's summary was made from a reading of its
 * transcript that differs from today's: its corrections changed, or, once
 * it is shared, the Organization reads other corrections than the owner
 * did. False for a summary made before corrections existed.
 */
export async function isSummaryStale(
    ownerUserId: string,
    recordingId: string,
): Promise<boolean> {
    const [summary] = await db
        .select({
            transcriptionId: aiEnhancements.transcriptionId,
            inputFingerprint: aiEnhancements.inputFingerprint,
        })
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.itemId, recordingId),
                eq(aiEnhancements.userId, ownerUserId),
                eq(aiEnhancements.source, "riffado"),
            ),
        )
        .limit(1);
    if (!summary?.inputFingerprint || !summary.transcriptionId) return false;
    const current = await llmRendering(summary.transcriptionId);
    return current !== null && current.fingerprint !== summary.inputFingerprint;
}

/**
 * Runs after the change it follows has committed: it never throws, so a
 * failure here does not report a change that took effect as failed (the
 * summary then says it may be stale).
 */
export async function refreshSummaryAfterCorrections(input: {
    ownerUserId: string;
    recordingId: string;
    view: RecordingView;
}): Promise<void> {
    try {
        await refresh(input);
    } catch (error) {
        console.error(
            `Could not refresh the summary of recording ${input.recordingId}:`,
            error,
        );
    }
}

async function refresh(input: {
    ownerUserId: string;
    recordingId: string;
    view: RecordingView;
}): Promise<void> {
    const due = await summaryRefreshDue(input);
    if (!due) return;
    await enqueueSummaryJob({
        userId: input.ownerUserId,
        recordingId: input.recordingId,
        presetId: due.presetId,
        trigger: "auto",
    });
}

/**
 * Whether the summary is to be made again now: on the private view, stale,
 * with auto-summarize on and within the hourly cap (spent when it is).
 * Null when not; otherwise the preset the automatic summary uses.
 */
export async function summaryRefreshDue(input: {
    ownerUserId: string;
    recordingId: string;
    view: RecordingView;
}): Promise<{ presetId?: string } | null> {
    if (input.view !== "private") return null;
    if (!(await isSummaryStale(input.ownerUserId, input.recordingId))) {
        return null;
    }
    const [settings] = await db
        .select({
            autoSummarize: userSettings.autoSummarize,
            preset: userSettings.autoSummarizePreset,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, input.ownerUserId))
        .limit(1);
    if (!settings?.autoSummarize) return null;
    const allowed = await consumeRateLimitBucket(
        `auto-summary:user:${input.ownerUserId}`,
        {
            limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
            windowMs: 60 * 60 * 1000,
        },
    );
    // Over the cap: the summary says it may be stale instead.
    if (!allowed.allowed) return null;
    return settings.preset ? { presetId: settings.preset } : {};
}
