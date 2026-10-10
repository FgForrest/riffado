/**
 * What a recording's page still waits for on its private view: automatic
 * Learn's hold (`summaryDueAt`), the correction pass a finished review
 * queued, and the jobs that make what it held back (the release, the
 * title, topics, the summary). The page follows them
 * after a review is finished, since none of them is queued by anything it
 * started.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { asyncJobs, chatterItems } from "@/db/schema";
import { LEARN_RELEASE_JOB_KIND } from "@/lib/learn/auto-learn";
import { LEARN_CORRECT_JOB_KIND } from "@/lib/learn/correction-pass-queue";
import { TITLE_JOB_KIND } from "@/lib/recordings/title-job";
import { recordingJobSubject } from "@/lib/sharing/view";
import { SUMMARY_JOB_KIND } from "@/lib/summary/summary-job";
import { TOPICS_JOB_KIND } from "@/lib/topics/topics-job";

export const FOLLOW_UP_JOB_KINDS = [
    LEARN_CORRECT_JOB_KIND,
    LEARN_RELEASE_JOB_KIND,
    TITLE_JOB_KIND,
    TOPICS_JOB_KIND,
    SUMMARY_JOB_KIND,
] as const;

export interface RecordingFollowUps {
    /** Title, summary and topics wait for the Learn review. */
    held: boolean;
    /** The follow-up jobs queued or running, by kind, sorted. */
    pending: string[];
}

/** The owner's recording only; null when it is not theirs, or deleted. */
export async function recordingFollowUps(
    userId: string,
    recordingId: string,
): Promise<RecordingFollowUps | null> {
    const [recording] = await db
        .select({ dueAt: chatterItems.summaryDueAt })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                eq(chatterItems.userId, userId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) return null;
    const active = await db
        .selectDistinct({ kind: asyncJobs.kind })
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.userId, userId),
                eq(
                    asyncJobs.subjectId,
                    recordingJobSubject(recordingId, "private"),
                ),
                inArray(asyncJobs.kind, [...FOLLOW_UP_JOB_KINDS]),
                sql`${asyncJobs.status} in ('pending', 'processing')`,
            ),
        );
    return {
        held: recording.dueAt !== null,
        pending: active.map((row) => row.kind).sort(),
    };
}
