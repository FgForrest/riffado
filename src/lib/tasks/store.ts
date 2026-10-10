import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { db } from "@/db";
import {
    aiEnhancements,
    people,
    recordingTaskRejections,
    recordingTasks,
    taskUpdateProposals,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { recordingSharedCondition } from "@/lib/knowledge/org-people";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * SQL: a follow-up still worth a review: its task is open, on a recording
 * not deleted that the follow-up's owner can see (theirs, or shared). The
 * review shows exactly these, and the share gate waits for exactly these.
 */
export function liveFollowUpCondition(): SQL {
    return sql`exists (
        select 1 from recording_tasks target
        inner join recordings target_recording
            on target_recording.id = target.recording_id
        where target.id = ${taskUpdateProposals.taskId}
            and target.status = 'open'
            and target_recording.deleted_at is null
            and (
                target_recording.user_id = ${taskUpdateProposals.userId}
                or ${recordingSharedCondition(sql`target_recording.id`)}
            )
    )`;
}

export interface ProposedTask {
    text: string;
    /** `fingerprintOf(text)`. */
    fingerprint: string;
    assigneePersonId: string | null;
    assigneeHint: string | null;
    assigneeCheck: boolean;
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
}

export interface ProposedTaskUpdate {
    taskId: string;
    kind: "done" | "due";
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
}

/** What one summary proposes, ready to store. */
export interface TaskProposals {
    source: "riffado" | "plaud";
    tasks: ProposedTask[];
    updates: ProposedTaskUpdate[];
    /**
     * The keyed fingerprint of a task text (`taskFingerprint`), passed in so
     * this module needs no secret of its own: the write compares the
     * recording's tasks under its lock.
     */
    fingerprintOf: (text: string) => string;
}

/**
 * Store a summary's proposals for its recording, in the summary's
 * transaction: they replace the proposals the same source made before that
 * nobody touched (edited, ticked, merged or added ones stay), skip what was
 * rejected on this recording or is already one of its rows, and replace
 * the untouched task updates this recording proposed.
 */
export async function writeTaskProposalsInTx(
    tx: Tx,
    {
        recordingId,
        ownerUserId,
        actorUserId,
        proposals,
    }: {
        recordingId: string;
        ownerUserId: string;
        actorUserId: string;
        proposals: TaskProposals;
    },
): Promise<void> {
    await tx
        .delete(recordingTasks)
        .where(
            and(
                eq(recordingTasks.itemId, recordingId),
                eq(recordingTasks.userId, ownerUserId),
                eq(recordingTasks.status, "proposed"),
                eq(recordingTasks.source, proposals.source),
                eq(recordingTasks.version, 0),
            ),
        );
    // Untouched follow-ups are heard again; stale ones (the task moved on)
    // have nothing left to review.
    await tx
        .delete(taskUpdateProposals)
        .where(
            and(
                eq(taskUpdateProposals.itemId, recordingId),
                eq(taskUpdateProposals.userId, ownerUserId),
                sql`(${taskUpdateProposals.version} = 0 or not ${liveFollowUpCondition()})`,
            ),
        );

    const rejected = new Set(
        (
            await tx
                .select({
                    fingerprint: recordingTaskRejections.fingerprintHmac,
                })
                .from(recordingTaskRejections)
                .where(
                    and(
                        eq(recordingTaskRejections.itemId, recordingId),
                        eq(recordingTaskRejections.userId, ownerUserId),
                    ),
                )
        ).map((row) => row.fingerprint),
    );
    const kept = await tx
        .select({
            text: recordingTasks.text,
            position: recordingTasks.position,
        })
        .from(recordingTasks)
        .where(
            and(
                eq(recordingTasks.itemId, recordingId),
                eq(recordingTasks.userId, ownerUserId),
            ),
        );
    let position = kept.reduce((max, row) => Math.max(max, row.position), -1);
    const known = new Set(
        kept.map((row) => proposals.fingerprintOf(decryptText(row.text))),
    );

    // What the summary named may have gone while it ran (minutes, with
    // several passes): a person deleted, a task closed or deleted.
    const assignees = [
        ...new Set(
            proposals.tasks.flatMap((task) =>
                task.assigneePersonId ? [task.assigneePersonId] : [],
            ),
        ),
    ];
    const livePeople = new Set(
        assignees.length > 0
            ? (
                  await tx
                      .select({ id: people.id })
                      .from(people)
                      .where(
                          and(
                              inArray(people.id, assignees),
                              isNull(people.mergedIntoId),
                          ),
                      )
              ).map((row) => row.id)
            : [],
    );
    const targets = [...new Set(proposals.updates.map((u) => u.taskId))];
    const openTasks = new Set(
        targets.length > 0
            ? (
                  await tx
                      .select({ id: recordingTasks.id })
                      .from(recordingTasks)
                      .where(
                          and(
                              inArray(recordingTasks.id, targets),
                              eq(recordingTasks.status, "open"),
                          ),
                      )
              ).map((row) => row.id)
            : [],
    );

    const rows = [];
    for (const task of proposals.tasks) {
        const { fingerprint } = task;
        if (rejected.has(fingerprint) || known.has(fingerprint)) continue;
        known.add(fingerprint);
        position += 1;
        rows.push({
            itemId: recordingId,
            userId: ownerUserId,
            status: "proposed" as const,
            text: encryptText(task.text),
            assigneePersonId:
                task.assigneePersonId && livePeople.has(task.assigneePersonId)
                    ? task.assigneePersonId
                    : null,
            assigneeHint: encryptText(task.assigneeHint),
            assigneeCheck: task.assigneeCheck,
            dueDate: task.dueDate,
            duePhrase: encryptText(task.duePhrase),
            quote: encryptText(task.quote),
            evidenceStartMs: task.evidenceStartMs,
            source: proposals.source,
            ticked: !task.assigneeCheck,
            position,
            createdByUserId: actorUserId,
        });
    }
    if (rows.length > 0) await tx.insert(recordingTasks).values(rows);

    const updates = proposals.updates.filter((update) =>
        openTasks.has(update.taskId),
    );
    if (updates.length > 0) {
        await tx
            .insert(taskUpdateProposals)
            .values(
                updates.map((update) => ({
                    taskId: update.taskId,
                    itemId: recordingId,
                    userId: ownerUserId,
                    kind: update.kind,
                    dueDate: update.dueDate,
                    duePhrase: encryptText(update.duePhrase),
                    quote: encryptText(update.quote),
                    evidenceStartMs: update.evidenceStartMs,
                })),
            )
            .onConflictDoNothing();
    }
}

/**
 * A recording's tasks, its remembered rejections, and the follow-ups heard
 * on it, gone: the recording itself is going.
 */
export async function deleteRecordingTasksInTx(
    tx: Tx,
    recordingId: string,
): Promise<void> {
    await tx
        .delete(taskUpdateProposals)
        .where(eq(taskUpdateProposals.itemId, recordingId));
    await tx
        .delete(recordingTasks)
        .where(eq(recordingTasks.itemId, recordingId));
    await tx
        .delete(recordingTaskRejections)
        .where(eq(recordingTaskRejections.itemId, recordingId));
}

/**
 * Tasks die with the summary (Johnny, 2026-10-07): once a recording has no
 * summary left (retention, Erase, deleting it), its tasks go too. Call it
 * after deleting a summary, in the same transaction.
 */
export async function dropTasksWithoutSummaryInTx(
    tx: Tx,
    { recordingId, ownerUserId }: { recordingId: string; ownerUserId: string },
): Promise<void> {
    const [left] = await tx
        .select({ id: aiEnhancements.id })
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.itemId, recordingId),
                eq(aiEnhancements.userId, ownerUserId),
            ),
        )
        .limit(1);
    if (!left) await deleteRecordingTasksInTx(tx, recordingId);
}
