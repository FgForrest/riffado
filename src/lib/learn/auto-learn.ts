/**
 * Automatic Learn and what waits for it (Task 5.5).
 *
 * With automatic Learn on, a transcript with timings starts a Learn run by
 * itself, and the recording's title, summary and topics are held back
 * (`chatterItems.summaryDueAt`) so they are made from the transcript as the
 * person's review corrects it. The hold is released, once, when:
 * - no Learn run on the recording's private view is open (`learnRunOpen`:
 *   ready for review, or queued or running with its job alive): the review
 *   finished, the run found nothing, failed, died, or was cancelled or
 *   superseded with no successor; and no correction pass the run's end
 *   queued is still to run (it releases the hold when it ends); or
 * - `summaryDueAt` passed (72 h): nobody reviewed, and the rest goes on
 *   without them.
 * A new Riffado transcript clears the hold in the transaction that writes
 * it (`transcriptRewrittenInTx`): that transcription makes its own title,
 * summary and topics, or holds them again. Erasing the transcript or
 * deleting the recording clears it too.
 *
 * Releasing clears the hold and queues one `learn.release` job in the same
 * transaction, so what waited is never lost to a crash between the two;
 * that job queues the title job, topics and the automatic summary as the
 * person's settings ask then, retried until it has. The jobs it queues
 * check again that no newer hold began (`isHeldForLearn`). With automatic
 * Learn off, nothing here runs: the title follows the transcription.
 */

import {
    and,
    eq,
    inArray,
    isNotNull,
    isNull,
    lte,
    ne,
    notExists,
    or,
} from "drizzle-orm";
import { db } from "@/db";
import { enqueueJobInTx, getActiveJob } from "@/db/queries/async-jobs";
import {
    aiEnhancements,
    asyncJobs,
    chatterItems,
    learnRuns,
    userSettings,
} from "@/db/schema";
import { env } from "@/lib/env";
import { nudge } from "@/lib/jobs/nudge";
import {
    InvalidJobPayloadError,
    type JobHandler,
    type JobResult,
} from "@/lib/jobs/types";
import { isLearnAvailableFor } from "@/lib/knowledge/availability";
import { LEARN_CORRECT_JOB_KIND } from "@/lib/learn/correction-pass-queue";
import { settleDeadLearnRuns, startLearnRun } from "@/lib/learn/learn-job";
import { learnRunOpen } from "@/lib/learn/learn-open";
import { isSummaryStale } from "@/lib/learn/summary-refresh";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { enqueueTitleJob } from "@/lib/recordings/title-job";
import { resolveRecordingAccess } from "@/lib/sharing/access";
import { recordingJobSubject } from "@/lib/sharing/view";
import { queueAutoSummary } from "@/lib/summary/auto-summary";
import { SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";
import { queueAutoTopics } from "@/lib/topics/topics-job";

/** How long the title, summary and topics wait for Learn's review. */
export const AUTO_LEARN_HOLD_MS = 72 * 60 * 60 * 1000;

export const LEARN_RELEASE_JOB_KIND = "learn.release";

/**
 * After a transcript with timings was written on the private view: start
 * automatic Learn and hold the title, summary and topics back, when the
 * person asked for it and it can run. Returns whether it holds them; when
 * not, the caller makes them now, as without automatic Learn. Never throws.
 */
export async function holdForAutoLearn(input: {
    userId: string;
    recordingId: string;
    timed: boolean;
}): Promise<boolean> {
    const { userId, recordingId, timed } = input;
    try {
        if (!timed) return false;
        const [settings] = await db
            .select({ autoLearn: userSettings.autoLearn })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);
        if (!settings?.autoLearn) return false;
        if (!(await isLearnAvailableFor(userId))) return false;
        const access = await resolveRecordingAccess(userId, recordingId);
        // Shared: the Organization's to change; its curator runs Learn.
        if (!access || access.role !== "owner" || access.shared) return false;
        // Same ceiling as the automatic summary, in its own bucket.
        const rateLimit = await consumeRateLimitBucket(
            `auto-learn:user:${userId}`,
            {
                limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
                windowMs: 60 * 60 * 1000,
            },
        );
        if (!rateLimit.allowed) return false;

        try {
            await startLearnRun({
                access: { ...access, view: "private", contentUserId: userId },
                actorUserId: userId,
                source: "riffado",
                trigger: "auto",
            });
        } catch (error) {
            console.error(
                `Automatic Learn could not start for recording ${recordingId}:`,
                error,
            );
            return false;
        }
        // Held once the run exists, so nothing between the two can find
        // the hold with no run to wait for. A run that settled before the
        // hold was set found no hold to release: checked here instead.
        const [held] = await db
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + AUTO_LEARN_HOLD_MS) })
            .where(
                and(
                    eq(chatterItems.id, recordingId),
                    eq(chatterItems.userId, userId),
                    isNull(chatterItems.deletedAt),
                ),
            )
            .returning({ id: chatterItems.id });
        if (!held) return false;
        await releaseAutoLearnHold(recordingId);
        return true;
    } catch (error) {
        console.error(
            `Automatic Learn skipped for recording ${recordingId}:`,
            error,
        );
        return false;
    }
}

/**
 * A correction pass on the recording's private view still to run: a job
 * queued or running, other than `exceptJobId` (the pass that asks).
 */
function correctionPending(
    recordingId: string | typeof chatterItems.id,
    exceptJobId?: string,
) {
    return db
        .select({ id: asyncJobs.id })
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.kind, LEARN_CORRECT_JOB_KIND),
                eq(asyncJobs.subjectId, recordingId),
                inArray(asyncJobs.status, ["pending", "processing"]),
                exceptJobId ? ne(asyncJobs.id, exceptJobId) : undefined,
            ),
        );
}

/**
 * Release a recording's hold when no run on its private view is open and
 * no correction pass is still to run (`expired`: when its time is up,
 * whatever is open). Exactly once: the hold is cleared by the statement
 * that checks it, and the release job is queued in the same transaction.
 * Returns whether it released. Never throws.
 */
export async function releaseAutoLearnHold(
    recordingId: string,
    {
        expired = false,
        now = new Date(),
        exceptJobId,
    }: {
        expired?: boolean;
        now?: Date;
        /** The correction pass releasing it, still running as it asks. */
        exceptJobId?: string;
    } = {},
): Promise<boolean> {
    try {
        if (!expired) await settleDeadLearnRuns(recordingId);
        const open = db
            .select({ id: learnRuns.id })
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.itemId, recordingId),
                    eq(learnRuns.view, "private"),
                    learnRunOpen(),
                ),
            );
        const released = await db.transaction(async (tx) => {
            const [row] = await tx
                .update(chatterItems)
                .set({ summaryDueAt: null })
                .where(
                    and(
                        eq(chatterItems.id, recordingId),
                        isNotNull(chatterItems.summaryDueAt),
                        // A renewed hold is not the one whose time was up.
                        expired
                            ? lte(chatterItems.summaryDueAt, now)
                            : and(
                                  notExists(open),
                                  notExists(
                                      correctionPending(
                                          recordingId,
                                          exceptJobId,
                                      ),
                                  ),
                              ),
                    ),
                )
                .returning({ userId: chatterItems.userId });
            if (!row) return false;
            await enqueueJobInTx(tx, {
                userId: row.userId,
                kind: LEARN_RELEASE_JOB_KIND,
                subjectId: recordingId,
                maxAttempts: 5,
                payload: { recordingId },
            });
            return true;
        });
        if (released) nudge();
        return released;
    } catch (error) {
        console.error(
            `Could not release what waited for Learn on recording ${recordingId}:`,
            error,
        );
        return false;
    }
}

/** What the transcription held back, as the person's settings ask now. */
async function queueReleased(
    userId: string,
    recordingId: string,
): Promise<JobResult> {
    const [recording] = await db
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                eq(chatterItems.userId, userId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) return { skipped: "gone" };
    const [settings] = await db
        .select({
            autoGenerateTitle: userSettings.autoGenerateTitle,
            autoSummarize: userSettings.autoSummarize,
            autoSummarizePreset: userSettings.autoSummarizePreset,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    const queued: string[] = [];
    // A failure here fails the job, which is retried: nothing is lost. The
    // summary first, and only while no summary of the transcript as it
    // reads now exists, so a retry does not pay for one twice. A summary a
    // person made while it waited is kept; one made from an older reading
    // (an automatic job that ran before a newer hold) is not. One already
    // queued (a retry, or a release put off behind the other transcript's
    // topics) reads the transcript when it runs; queueing it again would
    // only spend the hourly cap.
    const queuedSummary = await getActiveJob(
        SUMMARY_JOB_KIND,
        recordingJobSubject(recordingId, "private"),
    );
    if (settings?.autoSummarize && !queuedSummary) {
        const [made] = await db
            .select({ id: aiEnhancements.id })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, recordingId),
                    eq(aiEnhancements.userId, userId),
                    eq(aiEnhancements.source, "riffado"),
                ),
            )
            .limit(1);
        if (!made || (await isSummaryStale(userId, recordingId))) {
            await queueAutoSummary(
                userId,
                recordingId,
                settings.autoSummarizePreset ?? null,
                { strict: true },
            );
            queued.push("summary");
        }
    }
    await queueAutoTopics(userId, recordingId, "riffado", { strict: true });
    if (settings?.autoGenerateTitle ?? true) {
        await enqueueTitleJob(userId, recordingId);
        queued.push("title");
    }
    return { queued };
}

export interface LearnReleasePayload {
    recordingId: string;
}

export const learnReleaseJobHandler: JobHandler<LearnReleasePayload> = {
    kind: LEARN_RELEASE_JOB_KIND,
    concurrency: 2,
    maxAttempts: 5,
    timeoutMs: 60_000,
    backoff: { baseMs: 10_000, maxMs: 5 * 60_000, jitter: 0.3 },
    parsePayload(raw) {
        if (typeof raw.recordingId !== "string" || !raw.recordingId) {
            throw new InvalidJobPayloadError(
                LEARN_RELEASE_JOB_KIND,
                "recordingId",
            );
        }
        return { recordingId: raw.recordingId };
    },
    run: ({ userId, payload }) => queueReleased(userId, payload.recordingId),
};

/**
 * Release the holds whose time is up, and those nothing holds any more (a
 * run whose job died is settled first: its hold would otherwise wait out
 * the 72 h), a batch at a time. Only those: holds still waiting for their
 * review are never read, so however many there are, none of them keeps a
 * releasable one out of the batch.
 */
export async function sweepAutoLearnHolds(
    now = new Date(),
    limit = 500,
): Promise<number> {
    // Open as `learnRunOpen` says: a run whose job died holds nothing.
    const open = db
        .select({ id: learnRuns.id })
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.itemId, chatterItems.id),
                eq(learnRuns.view, "private"),
                learnRunOpen(),
            ),
        );
    const held = await db
        .select({ id: chatterItems.id, dueAt: chatterItems.summaryDueAt })
        .from(chatterItems)
        .where(
            and(
                isNotNull(chatterItems.summaryDueAt),
                or(
                    lte(chatterItems.summaryDueAt, now),
                    and(
                        notExists(open),
                        notExists(correctionPending(chatterItems.id)),
                    ),
                ),
            ),
        )
        .orderBy(chatterItems.summaryDueAt)
        .limit(limit);
    let released = 0;
    for (const { id, dueAt } of held) {
        const expired = dueAt !== null && dueAt <= now;
        if (await releaseAutoLearnHold(id, { expired, now })) released++;
    }
    return released;
}

const SWEEP_MS = 5 * 60 * 1000;
let sweeper: ReturnType<typeof setInterval> | undefined;

/** Idempotent. The timeout is in hours; a few minutes late is fine. */
export function startAutoLearnSweeper(): void {
    if (sweeper) return;
    sweeper = setInterval(() => {
        void sweepAutoLearnHolds().catch((error) =>
            console.error("[auto-learn] sweep failed:", error),
        );
    }, SWEEP_MS);
    sweeper.unref?.();
}
