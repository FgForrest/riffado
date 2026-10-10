/**
 * Queueing the correction pass (`correction-pass.ts`) when a Learn run
 * finishes: in the transaction that finishes it, so the pass exists
 * exactly when the run is finished, and the title, summary and topics
 * automatic Learn held back wait for it too (`releaseAutoLearnHold`).
 */

import { eq } from "drizzle-orm";
import type { db } from "@/db";
import { enqueueJobInTx } from "@/db/queries/async-jobs";
import {
    type learnRuns,
    transcriptCorrectionPasses,
    userSettings,
} from "@/db/schema";
import { recordingJobSubject } from "@/lib/sharing/view";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const LEARN_CORRECT_JOB_KIND = "learn.correct";
export const LEARN_CORRECT_MAX_ATTEMPTS = 2;

/**
 * Queue the correction pass after `run` finished, unless the person who
 * ran it turned it off (it is on by default) or a pass on the recording's
 * view is already queued or running. Returns whether one was queued.
 */
export async function queueCorrectionPassInTx(
    tx: Tx,
    run: Pick<
        typeof learnRuns.$inferSelect,
        | "id"
        | "userId"
        | "scopeUserId"
        | "itemId"
        | "transcriptionId"
        | "transcriptRevision"
        | "view"
        | "actorUserId"
    > & { transcriptionId: string },
): Promise<boolean> {
    if (!run.actorUserId) return false;
    const [settings] = await tx
        .select({ correctAfterLearn: userSettings.correctAfterLearn })
        .from(userSettings)
        .where(eq(userSettings.userId, run.actorUserId))
        .limit(1);
    if (settings && !settings.correctAfterLearn) return false;
    const [pass] = await tx
        .insert(transcriptCorrectionPasses)
        .values({
            userId: run.userId,
            scopeUserId: run.scopeUserId,
            recordingId: run.itemId,
            transcriptionId: run.transcriptionId,
            transcriptRevision: run.transcriptRevision,
            learnRunId: run.id,
            view: run.view,
            actorUserId: run.actorUserId,
        })
        .returning({ id: transcriptCorrectionPasses.id });
    if (!pass) return false;
    const queued = await enqueueJobInTx(tx, {
        userId: run.actorUserId,
        kind: LEARN_CORRECT_JOB_KIND,
        subjectId: recordingJobSubject(run.itemId, run.view),
        maxAttempts: LEARN_CORRECT_MAX_ATTEMPTS,
        payload: { passId: pass.id },
    });
    if (!queued) {
        await tx
            .delete(transcriptCorrectionPasses)
            .where(eq(transcriptCorrectionPasses.id, pass.id));
    }
    return queued;
}
