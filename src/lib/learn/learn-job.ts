/**
 * Starting a Learn run: the run row and its job (kind `learn.run`, subject
 * `recordingJobSubject(recordingId, view)`, so it is in every cancellation
 * list the recording's other jobs are). Light, like `topics-job.ts`: the
 * route imports this; only the worker imports the handler.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { enqueueJob } from "@/db/queries/async-jobs";
import {
    asyncJobs,
    chatterItems,
    learnRuns,
    mailContents,
    mailMessages,
    recordings,
    transcriptions,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";
import { isLearnAvailableFor } from "@/lib/knowledge/availability";
import { isUntimed } from "@/lib/knowledge/correction-anchors";
import { vocabularyVersion } from "@/lib/knowledge/vocabulary";
import { learnRunDead, learnRunOpen } from "@/lib/learn/learn-open";
import type { RecordingViewContext } from "@/lib/sharing/access";
import { type RecordingView, recordingJobSubject } from "@/lib/sharing/view";
import { contentWriterRefusal, writerRefusalError } from "@/lib/sharing/writer";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

export const LEARN_JOB_KIND = "learn.run";
export const LEARN_PRIORITY_MANUAL = 10;
export const LEARN_PRIORITY_AUTO = 0;
export const LEARN_MAX_ATTEMPTS = 2;

export type LearnSource = "plaud" | "riffado";

export interface LearnJobPayload {
    runId: string;
}

export function parseLearnJobPayload(
    raw: Record<string, unknown>,
): LearnJobPayload {
    if (typeof raw.runId !== "string" || raw.runId.length === 0) {
        throw new InvalidJobPayloadError(
            LEARN_JOB_KIND,
            "runId must be a non-empty string",
        );
    }
    return { runId: raw.runId };
}

export interface StartedLearnRun {
    runId: string;
    jobId: string | null;
    /** False when a run of this transcript in this view was already open. */
    created: boolean;
}

/**
 * Start a Learn run on one transcript of a recording in a view, or return
 * the one already queued or running there. The caller authorized the view
 * and the change (`assertMayChange`): the owner on the private view, the
 * organization account on the Organization's. The actor's chat provider
 * pays, as for summaries.
 *
 * Refused: Learn not available to the actor (no chat provider, or a hosted
 * instance), no such transcript, or one without timed turns.
 */
export async function startLearnRun(input: {
    access: RecordingViewContext;
    actorUserId: string;
    source: LearnSource;
    trigger: "manual" | "auto";
}): Promise<StartedLearnRun> {
    const { access, actorUserId, source, trigger } = input;
    if (!(await isLearnAvailableFor(actorUserId))) {
        throw new AppError(
            ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
            "Learn needs a chat provider. Add an OpenAI-compatible provider to run it.",
            400,
        );
    }
    const view: RecordingView = access.view;
    await settleDeadLearnRuns(access.recordingId);
    // The run, under the lock sharing, withdrawal, rewrites and erasure
    // take, with the transcript read and the writer rule checked there: a
    // share, withdrawal, rewrite or erase that landed since the route
    // authorized the actor is seen.
    const inserted = await db.transaction(async (tx) => {
        if (access.kind === "mail") {
            return insertMailRunInTx(tx, { access, actorUserId, trigger });
        }
        const [live] = await tx
            .select({ id: recordings.id })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, access.recordingId),
                    isNull(recordings.deletedAt),
                ),
            )
            .for("share");
        if (!live) {
            throw new AppError(
                ErrorCode.RECORDING_NOT_FOUND,
                "Recording not found",
                404,
            );
        }
        const [transcript] = await tx
            .select({
                id: transcriptions.id,
                revision: transcriptions.revision,
                turns: transcriptions.turns,
            })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, access.recordingId),
                    eq(transcriptions.userId, access.ownerUserId),
                    eq(transcriptions.source, source),
                ),
            )
            .limit(1);
        if (!transcript) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "This recording has no such transcript",
                400,
            );
        }
        const turns = readTranscriptTurns(transcript);
        if (!turns?.length || isUntimed(turns)) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "This transcript has no timings, so Learn cannot read it. Transcribe it with a provider that reports them.",
                400,
            );
        }
        const refusal = await contentWriterRefusal(tx, {
            recordingId: access.recordingId,
            ownerUserId: access.ownerUserId,
            actorUserId,
            orgUserId: access.orgUserId,
        });
        if (refusal) throw writerRefusalError(refusal);
        // One open run per transcript and view: one learning, or one whose
        // review waits (a second would leave that review unreachable).
        const [open] = await tx
            .select({ id: learnRuns.id, jobId: learnRuns.jobId })
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.transcriptionId, transcript.id),
                    eq(learnRuns.view, view),
                    learnRunOpen(),
                ),
            )
            .orderBy(desc(learnRuns.createdAt))
            .limit(1);
        if (open) return { open };
        const [run] = await tx
            .insert(learnRuns)
            .values({
                userId: access.ownerUserId,
                scopeUserId:
                    view === "org" && access.orgUserId
                        ? access.orgUserId
                        : access.ownerUserId,
                itemId: access.recordingId,
                transcriptionId: transcript.id,
                view,
                actorUserId,
                trigger,
                transcriptRevision: transcript.revision,
                vocabularyVersion: await vocabularyVersion(tx),
            })
            .returning({ id: learnRuns.id });
        return {
            runId: (run as { id: string }).id,
            transcriptionId: transcript.id,
        };
    });
    if ("open" in inserted) {
        return {
            runId: inserted.open.id,
            jobId: inserted.open.jobId,
            created: false,
        };
    }
    const runId = inserted.runId;
    const transcriptionId = inserted.transcriptionId;
    const enqueue = () =>
        enqueueJob({
            userId: actorUserId,
            kind: LEARN_JOB_KIND,
            subjectId: recordingJobSubject(access.recordingId, view),
            priority:
                trigger === "manual"
                    ? LEARN_PRIORITY_MANUAL
                    : LEARN_PRIORITY_AUTO,
            maxAttempts: LEARN_MAX_ATTEMPTS,
            payload: { runId },
        });
    const abandon = () => db.delete(learnRuns).where(eq(learnRuns.id, runId));
    let queued: Awaited<ReturnType<typeof enqueue>>;
    try {
        queued = await enqueue();
        // One Learn job per recording and view. A job that holds the slot
        // for a run nobody waits for any more (superseded, failed, gone)
        // and has not started is let go, and this one queued instead.
        if (!queued.created && queued.job.payload.runId !== runId) {
            const holderId = String(queued.job.payload.runId);
            const [holder] = await db
                .select({
                    transcriptionId: learnRuns.transcriptionId,
                    status: learnRuns.status,
                })
                .from(learnRuns)
                .where(eq(learnRuns.id, holderId))
                .limit(1);
            const holderOpen =
                holder?.status === "queued" || holder?.status === "running";
            if (holderOpen && holder?.transcriptionId === transcriptionId) {
                await abandon();
                return {
                    runId: holderId,
                    jobId: queued.job.id,
                    created: false,
                };
            }
            if (!holderOpen && queued.job.status === "pending") {
                await db
                    .update(asyncJobs)
                    .set({
                        status: "failed",
                        completedAt: new Date(),
                        updatedAt: new Date(),
                        lastError: "Its Learn run is no longer waiting",
                    })
                    .where(
                        and(
                            eq(asyncJobs.id, queued.job.id),
                            eq(asyncJobs.status, "pending"),
                        ),
                    );
                queued = await enqueue();
            }
            if (!queued.created && queued.job.payload.runId !== runId) {
                await abandon();
                throw new AppError(
                    ErrorCode.CONFLICT,
                    holderOpen
                        ? "Learn is already running on this recording's other transcript. Try again when it finishes."
                        : "Learn is finishing on this recording. Try again in a moment.",
                    409,
                );
            }
        }
    } catch (error) {
        // Not queued: the run must not wait for a job that never comes.
        await abandon().catch(() => {});
        throw error;
    }
    await db
        .update(learnRuns)
        .set({ jobId: queued.job.id, updatedAt: new Date() })
        .where(eq(learnRuns.id, runId));
    if (queued.created) nudge();
    return { runId, jobId: queued.job.id, created: true };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * `startLearnRun`'s run on a mail, in its transaction: under the item's lock,
 * on the content revision there is now. Machine-sent mail and mail whose
 * content could not be read are not read.
 */
async function insertMailRunInTx(
    tx: Tx,
    {
        access,
        actorUserId,
        trigger,
    }: {
        access: RecordingViewContext;
        actorUserId: string;
        trigger: "manual" | "auto";
    },
): Promise<
    | { open: { id: string; jobId: string | null } }
    | { runId: string; transcriptionId: null }
> {
    const view: RecordingView = access.view;
    const [live] = await tx
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, access.recordingId),
                eq(chatterItems.kind, "mail"),
                isNull(chatterItems.deletedAt),
            ),
        )
        .for("share");
    if (!live) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Mail not found",
            404,
        );
    }
    const [[mail], [content]] = await Promise.all([
        tx
            .select({
                autoGenerated: mailMessages.autoGenerated,
                unreadable: mailMessages.unreadable,
            })
            .from(mailMessages)
            .where(
                and(
                    eq(mailMessages.id, access.recordingId),
                    eq(mailMessages.userId, access.ownerUserId),
                ),
            )
            .limit(1),
        tx
            .select({ revision: mailContents.revision })
            .from(mailContents)
            .where(
                and(
                    eq(mailContents.itemId, access.recordingId),
                    eq(mailContents.userId, access.ownerUserId),
                ),
            )
            .limit(1),
    ]);
    if (!mail || mail.autoGenerated || mail.unreadable || !content) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Learn does not read mail sent by machines, nor mail whose content cannot be read.",
            400,
        );
    }
    const refusal = await contentWriterRefusal(tx, {
        recordingId: access.recordingId,
        ownerUserId: access.ownerUserId,
        actorUserId,
        orgUserId: access.orgUserId,
    });
    if (refusal) throw writerRefusalError(refusal);
    const [open] = await tx
        .select({ id: learnRuns.id, jobId: learnRuns.jobId })
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.itemId, access.recordingId),
                isNull(learnRuns.transcriptionId),
                eq(learnRuns.view, view),
                learnRunOpen(),
            ),
        )
        .orderBy(desc(learnRuns.createdAt))
        .limit(1);
    if (open) return { open };
    const [run] = await tx
        .insert(learnRuns)
        .values({
            userId: access.ownerUserId,
            scopeUserId:
                view === "org" && access.orgUserId
                    ? access.orgUserId
                    : access.ownerUserId,
            itemId: access.recordingId,
            transcriptionId: null,
            view,
            actorUserId,
            trigger,
            // A mail's content revision: a re-parse supersedes the run.
            transcriptRevision: content.revision,
            vocabularyVersion: await vocabularyVersion(tx),
        })
        .returning({ id: learnRuns.id });
    return { runId: (run as { id: string }).id, transcriptionId: null };
}

/**
 * Fail the runs of a recording still queued or running whose job is gone
 * (buried after a crash, or never queued): nothing will finish them.
 */
export async function settleDeadLearnRuns(recordingId: string): Promise<void> {
    await db
        .update(learnRuns)
        .set({
            status: "failed",
            errorCode: ErrorCode.INTERNAL_ERROR,
            finishedAt: new Date(),
            updatedAt: new Date(),
        })
        .where(and(eq(learnRuns.itemId, recordingId), learnRunDead()));
}
