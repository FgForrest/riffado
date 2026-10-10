import {
    and,
    asc,
    desc,
    eq,
    gt,
    gte,
    inArray,
    isNull,
    lt,
    lte,
    ne,
    not,
    type SQL,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import {
    chatterItems,
    people,
    recordings,
    recordingTaskRejections,
    recordingTasks,
    taskUpdateProposals,
    userSettings,
} from "@/db/schema";
import { type Keyset, keysetBefore, keysetOrder } from "@/lib/db/keyset";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    exportRecordingSidecarsIfEnabled,
    refreshExistingRecordingSidecars,
} from "@/lib/export/document-sidecars";
import { folderCondition } from "@/lib/folders/condition";
import { assertOrgScopeWritable } from "@/lib/org/config";
import { notifyIfShared } from "@/lib/sharing/notify";
import {
    assignedToViewer,
    type TaskViewer,
    taskClosable,
    taskEditable,
    taskListed,
    taskRecordingShared,
    taskVisible,
} from "@/lib/tasks/access";
import { taskFingerprint } from "@/lib/tasks/proposals";
import { liveFollowUpCondition } from "@/lib/tasks/store";
import { isoDateOrNull } from "@/lib/tasks/summary-items";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TaskStatus = "proposed" | "open" | "done" | "dropped";

const MAX_TEXT = 500;
const LIST_LIMIT = 200;

/** A task or proposal as the client gets it. */
export interface TaskView {
    id: string;
    recordingId: string;
    status: TaskStatus;
    text: string;
    assignee: { personId: string; name: string } | null;
    assigneeHint: string | null;
    assigneeCheck: boolean;
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
    source: "riffado" | "plaud" | "manual";
    ticked: boolean;
    version: number;
    createdAt: string;
    acceptedAt: string | null;
    statusChangedAt: string | null;
    /** The viewer may change it (text, assignee, due, drop). */
    canEdit: boolean;
    /** The viewer may mark it done or open again. */
    canClose: boolean;
}

/** A follow-up heard on a recording, about a task of another. */
export interface TaskUpdateView {
    id: string;
    kind: "done" | "due";
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
    ticked: boolean;
    version: number;
    task: {
        id: string;
        recordingId: string;
        recordingTitle: string;
        text: string;
        dueDate: string | null;
        assigneeName: string | null;
    };
}

export interface RecordingTasks {
    /** The viewer reviews and edits this recording's tasks. */
    canEdit: boolean;
    /**
     * Its tasks were reviewed at least once (something was accepted or
     * rejected): the summary's own action items no longer stand for them.
     */
    reviewed: boolean;
    tasks: TaskView[];
    /** Waiting for review; only its reviewer sees them. */
    proposals: TaskView[];
    updates: TaskUpdateView[];
}

function notFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Task not found", 404);
}

function forbidden(): AppError {
    return new AppError(
        ErrorCode.FORBIDDEN,
        "You may not change this task",
        403,
    );
}

function versionConflict(): AppError {
    return new AppError(
        ErrorCode.CONFLICT,
        "The task changed meanwhile; reload it",
        409,
    );
}

function decryptOptional(value: string | null | undefined): string | null {
    return value ? decryptText(value) : null;
}

/**
 * After a task changed: tell the Organization's open tabs, and bring the
 * recording's Markdown exports (which list its tasks) up to date.
 */
async function tasksChanged(
    ownerUserId: string,
    recordingId: string,
): Promise<void> {
    await notifyIfShared(recordingId);
    await refreshExistingRecordingSidecars(ownerUserId, recordingId);
    await exportRecordingSidecarsIfEnabled(ownerUserId, recordingId, "summary");
}

function iso(value: Date | null): string | null {
    return value ? value.toISOString() : null;
}

const taskColumns = {
    id: recordingTasks.id,
    recordingId: recordingTasks.itemId,
    status: recordingTasks.status,
    text: recordingTasks.text,
    assigneePersonId: recordingTasks.assigneePersonId,
    assigneeName: people.displayName,
    assigneeHint: recordingTasks.assigneeHint,
    assigneeCheck: recordingTasks.assigneeCheck,
    dueDate: recordingTasks.dueDate,
    duePhrase: recordingTasks.duePhrase,
    quote: recordingTasks.quote,
    evidenceStartMs: recordingTasks.evidenceStartMs,
    source: recordingTasks.source,
    ticked: recordingTasks.ticked,
    version: recordingTasks.version,
    createdAt: recordingTasks.createdAt,
    acceptedAt: recordingTasks.acceptedAt,
    statusChangedAt: recordingTasks.statusChangedAt,
};

type TaskSelect = {
    [K in keyof typeof taskColumns]:
        | (typeof taskColumns)[K]["_"]["data"]
        | null;
};

function toView(
    row: TaskSelect & { canEdit: boolean; canClose: boolean },
): TaskView {
    return {
        id: row.id as string,
        recordingId: row.recordingId as string,
        status: row.status as TaskStatus,
        text: decryptText(row.text as string),
        assignee:
            row.assigneePersonId && row.assigneeName
                ? {
                      personId: row.assigneePersonId,
                      name: decryptText(row.assigneeName),
                  }
                : null,
        assigneeHint: decryptOptional(row.assigneeHint),
        assigneeCheck: row.assigneeCheck === true,
        dueDate: row.dueDate,
        duePhrase: decryptOptional(row.duePhrase),
        quote: decryptOptional(row.quote),
        evidenceStartMs: row.evidenceStartMs,
        source: row.source as TaskView["source"],
        ticked: row.ticked === true,
        version: row.version ?? 0,
        createdAt: (row.createdAt as Date).toISOString(),
        acceptedAt: iso(row.acceptedAt),
        statusChangedAt: iso(row.statusChangedAt),
        canEdit: row.canEdit,
        canClose: row.canClose,
    };
}

/** The assignee's name, from a person of the owner's or the Organization's. */
function assigneeJoin() {
    return eq(people.id, recordingTasks.assigneePersonId);
}

/**
 * A recording's tasks as `viewer` sees them: everyone who sees the
 * recording sees its tasks; its reviewer also the proposals waiting.
 * Null when the viewer may not see the recording.
 */
export async function listRecordingTasks(
    viewer: TaskViewer,
    recordingId: string,
): Promise<RecordingTasks | null> {
    const [recording] = await db
        .select({
            id: recordings.id,
            canEdit: sql<boolean>`${taskEditable(viewer)}`,
        })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                isNull(recordings.deletedAt),
                taskVisible(viewer),
            ),
        )
        .limit(1);
    if (!recording) return null;

    const rows = await db
        .select({
            ...taskColumns,
            canEdit: sql<boolean>`${taskEditable(viewer)}`,
            canClose: sql<boolean>`${taskClosable(viewer)}`,
        })
        .from(recordingTasks)
        .innerJoin(recordings, eq(recordings.id, recordingTasks.itemId))
        .leftJoin(people, assigneeJoin())
        .where(
            and(
                eq(recordingTasks.itemId, recordingId),
                // Again here: the recording may be withdrawn meanwhile.
                taskVisible(viewer),
                recording.canEdit
                    ? undefined
                    : ne(recordingTasks.status, "proposed"),
            ),
        )
        .orderBy(asc(recordingTasks.position), asc(recordingTasks.createdAt));
    const views = rows.map(toView);
    const [rejection] = await db
        .select({ id: recordingTaskRejections.id })
        .from(recordingTaskRejections)
        .where(eq(recordingTaskRejections.itemId, recordingId))
        .limit(1);

    return {
        canEdit: recording.canEdit,
        reviewed:
            rejection !== undefined ||
            views.some((task) => task.status !== "proposed"),
        tasks: views.filter((task) => task.status !== "proposed"),
        proposals: views.filter((task) => task.status === "proposed"),
        updates: recording.canEdit
            ? await listUpdateProposals(viewer, recordingId)
            : [],
    };
}

/**
 * The follow-ups heard on a recording, about tasks the viewer can still
 * see: a task's recording withdrawn from the Organization since is no
 * longer the Organization's to read.
 */
async function listUpdateProposals(
    viewer: TaskViewer,
    recordingId: string,
): Promise<TaskUpdateView[]> {
    const rows = await db
        .select({
            id: taskUpdateProposals.id,
            kind: taskUpdateProposals.kind,
            dueDate: taskUpdateProposals.dueDate,
            duePhrase: taskUpdateProposals.duePhrase,
            quote: taskUpdateProposals.quote,
            evidenceStartMs: taskUpdateProposals.evidenceStartMs,
            ticked: taskUpdateProposals.ticked,
            version: taskUpdateProposals.version,
            taskId: recordingTasks.id,
            taskRecordingId: recordingTasks.itemId,
            taskText: recordingTasks.text,
            taskDueDate: recordingTasks.dueDate,
            taskStatus: recordingTasks.status,
            recordingTitle: chatterItems.title,
            assigneeName: people.displayName,
        })
        .from(taskUpdateProposals)
        .innerJoin(
            recordingTasks,
            eq(recordingTasks.id, taskUpdateProposals.taskId),
        )
        .innerJoin(recordings, eq(recordings.id, recordingTasks.itemId))
        .innerJoin(chatterItems, recordingItemJoin)
        .leftJoin(people, assigneeJoin())
        .where(
            and(
                eq(taskUpdateProposals.itemId, recordingId),
                isNull(recordings.deletedAt),
                taskVisible(viewer),
            ),
        )
        .orderBy(asc(taskUpdateProposals.createdAt));
    return rows
        .filter((row) => row.taskStatus === "open")
        .map((row) => ({
            id: row.id,
            kind: row.kind,
            dueDate: row.dueDate,
            duePhrase: decryptOptional(row.duePhrase),
            quote: decryptOptional(row.quote),
            evidenceStartMs: row.evidenceStartMs,
            ticked: row.ticked,
            version: row.version,
            task: {
                id: row.taskId,
                recordingId: row.taskRecordingId,
                recordingTitle: decryptText(row.recordingTitle),
                text: decryptText(row.taskText),
                dueDate: row.taskDueDate,
                assigneeName: decryptOptional(row.assigneeName),
            },
        }));
}

interface LockedTask {
    id: string;
    recordingId: string;
    ownerUserId: string;
    status: TaskStatus;
    text: string;
    version: number;
    canEdit: boolean;
    canClose: boolean;
    shared: boolean;
}

/**
 * Read a task for a change, its recording locked (sharing and withdrawal
 * take the same lock, so who may change it cannot move underneath).
 */
async function lockTask(
    tx: Tx,
    viewer: TaskViewer,
    taskId: string,
): Promise<LockedTask> {
    if (viewer.isOrg) assertOrgScopeWritable();
    const [row] = await tx
        .select({
            id: recordingTasks.id,
            recordingId: recordingTasks.itemId,
            ownerUserId: recordings.userId,
            status: recordingTasks.status,
            text: recordingTasks.text,
            version: recordingTasks.version,
            visible: sql<boolean>`${taskVisible(viewer)}`,
            canEdit: sql<boolean>`${taskEditable(viewer)}`,
            canClose: sql<boolean>`${taskClosable(viewer)}`,
            shared: sql<boolean>`${taskRecordingShared(viewer)}`,
        })
        .from(recordingTasks)
        .innerJoin(recordings, eq(recordings.id, recordingTasks.itemId))
        .where(and(eq(recordingTasks.id, taskId), isNull(recordings.deletedAt)))
        .for("update", { of: recordings })
        .limit(1);
    if (!row?.visible) throw notFound();
    // A proposal is its reviewer's alone.
    if (row.status === "proposed" && !row.canEdit) throw notFound();
    return { ...row, text: decryptText(row.text) };
}

/** Lock a recording the viewer reviews, refusing anyone else. */
async function lockRecordingForEdit(
    tx: Tx,
    viewer: TaskViewer,
    recordingId: string,
): Promise<{ ownerUserId: string; shared: boolean }> {
    if (viewer.isOrg) assertOrgScopeWritable();
    const [row] = await tx
        .select({
            ownerUserId: recordings.userId,
            visible: sql<boolean>`${taskVisible(viewer)}`,
            canEdit: sql<boolean>`${taskEditable(viewer)}`,
            shared: sql<boolean>`${taskRecordingShared(viewer)}`,
        })
        .from(recordings)
        .where(
            and(eq(recordings.id, recordingId), isNull(recordings.deletedAt)),
        )
        .for("update")
        .limit(1);
    if (!row?.visible) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    if (!row.canEdit) throw forbidden();
    return row;
}

/**
 * The person a task may be assigned to on a recording, as stored: the
 * survivor of a merge, of the owner's Almanac or the Organization's (on a
 * shared recording the Organization's only, so nothing private surfaces).
 */
async function assignablePerson(
    tx: Tx,
    personId: string,
    { ownerUserId, shared }: { ownerUserId: string; shared: boolean },
    orgUserId: string | null,
): Promise<string> {
    const [row] = await tx
        .select({
            id: people.id,
            userId: people.userId,
            mergedIntoId: people.mergedIntoId,
        })
        .from(people)
        .where(eq(people.id, personId))
        .limit(1);
    if (row?.mergedIntoId) {
        return assignablePerson(
            tx,
            row.mergedIntoId,
            { ownerUserId, shared },
            orgUserId,
        );
    }
    const allowed =
        row &&
        ((orgUserId !== null && row.userId === orgUserId) ||
            (!shared && row.userId === ownerUserId));
    if (!allowed) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "That person cannot be assigned here",
            400,
            { field: "assigneePersonId" },
        );
    }
    return row.id;
}

function cleanText(text: string): string {
    const trimmed = text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
    if (!trimmed) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "A task needs a text",
            400,
            { field: "text" },
        );
    }
    return trimmed;
}

function cleanDue(value: string | null): string | null {
    if (value === null) return null;
    const date = isoDateOrNull(value);
    if (!date) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A due date is a day, YYYY-MM-DD",
            400,
            { field: "dueDate" },
        );
    }
    return date;
}

export interface NewTask {
    text: string;
    assigneePersonId?: string | null;
    dueDate?: string | null;
    /** `proposed` adds a row to the review; `open` a task at once. */
    status: "proposed" | "open";
}

/** Add a task by hand to a recording the viewer reviews. */
export async function addTask(
    viewer: TaskViewer,
    recordingId: string,
    input: NewTask,
): Promise<TaskView> {
    const text = cleanText(input.text);
    const dueDate = cleanDue(input.dueDate ?? null);
    const id = await db.transaction(async (tx) => {
        const recording = await lockRecordingForEdit(tx, viewer, recordingId);
        const assigneePersonId = input.assigneePersonId
            ? await assignablePerson(
                  tx,
                  input.assigneePersonId,
                  recording,
                  viewer.orgUserId,
              )
            : null;
        const [last] = await tx
            .select({
                position: sql<number | null>`max(${recordingTasks.position})`,
            })
            .from(recordingTasks)
            .where(eq(recordingTasks.itemId, recordingId));
        const now = new Date();
        const open = input.status === "open";
        const [row] = await tx
            .insert(recordingTasks)
            .values({
                itemId: recordingId,
                userId: recording.ownerUserId,
                status: input.status,
                text: encryptText(text),
                assigneePersonId,
                dueDate,
                source: "manual",
                ticked: true,
                position: (last?.position ?? -1) + 1,
                createdByUserId: viewer.userId,
                acceptedAt: open ? now : null,
                assignedAt: open && assigneePersonId ? now : null,
                acceptedByUserId: open ? viewer.userId : null,
                updatedByUserId: viewer.userId,
            })
            .returning({ id: recordingTasks.id });
        return { id: row?.id ?? "", ownerUserId: recording.ownerUserId };
    });
    await tasksChanged(id.ownerUserId, recordingId);
    return requireTaskView(viewer, id.id);
}

export interface TaskChange {
    version: number;
    text?: string;
    assigneePersonId?: string | null;
    dueDate?: string | null;
    /** A proposal's draft tick. */
    ticked?: boolean;
    /** Move an accepted task between open, done and dropped. */
    status?: "open" | "done" | "dropped";
}

/**
 * Change a task or a proposal. Closing and reopening need `canClose`;
 * everything else, dropping included, needs `canEdit`. Refused with 409
 * when someone changed it since `version` was read.
 */
export async function updateTask(
    viewer: TaskViewer,
    taskId: string,
    change: TaskChange,
): Promise<TaskView> {
    const task = await db.transaction(async (tx) => {
        const task = await lockTask(tx, viewer, taskId);
        if (task.version !== change.version) throw versionConflict();

        const editing =
            change.text !== undefined ||
            change.assigneePersonId !== undefined ||
            change.dueDate !== undefined ||
            change.ticked !== undefined ||
            change.status === "dropped" ||
            (change.status !== undefined && task.status === "dropped");
        if (editing && !task.canEdit) throw forbidden();
        if (change.status !== undefined) {
            if (task.status === "proposed") {
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Accept the review first",
                    400,
                    { field: "status" },
                );
            }
            if (!task.canEdit && !task.canClose) throw forbidden();
        }
        if (change.ticked !== undefined && task.status !== "proposed") {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Only a proposal is ticked",
                400,
                { field: "ticked" },
            );
        }

        const now = new Date();
        const set: Partial<typeof recordingTasks.$inferInsert> = {
            version: task.version + 1,
            updatedAt: now,
            updatedByUserId: viewer.userId,
        };
        if (change.text !== undefined) {
            const text = cleanText(change.text);
            set.text = encryptText(text);
            // The summary would say it in its old words again.
            if (text !== task.text) {
                await rejectInTx(tx, task, [task.text]);
            }
        }
        if (change.assigneePersonId !== undefined) {
            set.assigneePersonId = change.assigneePersonId
                ? await assignablePerson(
                      tx,
                      change.assigneePersonId,
                      task,
                      viewer.orgUserId,
                  )
                : null;
            set.assigneeHint = null;
            set.assigneeCheck = false;
            // A task, not a proposal: news for whoever it names now.
            if (task.status !== "proposed" && set.assigneePersonId) {
                set.assignedAt = now;
            }
        }
        if (change.dueDate !== undefined) {
            set.dueDate = cleanDue(change.dueDate);
        }
        if (change.ticked !== undefined) set.ticked = change.ticked;
        if (change.status !== undefined && change.status !== task.status) {
            set.status = change.status;
            set.statusChangedAt = now;
            set.statusChangedByUserId = viewer.userId;
        }
        await tx
            .update(recordingTasks)
            .set(set)
            .where(eq(recordingTasks.id, taskId));
        return task;
    });
    await tasksChanged(task.ownerUserId, task.recordingId);
    return requireTaskView(viewer, taskId);
}

async function rejectInTx(
    tx: Tx,
    { recordingId, ownerUserId }: { recordingId: string; ownerUserId: string },
    texts: readonly string[],
): Promise<void> {
    if (texts.length === 0) return;
    await tx
        .insert(recordingTaskRejections)
        .values(
            texts.map((text) => ({
                userId: ownerUserId,
                itemId: recordingId,
                fingerprintHmac: taskFingerprint(text),
            })),
        )
        .onConflictDoNothing();
}

/**
 * Fold several proposals of a recording into the first: their texts joined,
 * the first assignee that has one, the earliest due date, the first quote.
 * The others go. Every text merged is remembered as rejected, so the next
 * summary does not split them out again.
 */
export async function mergeProposals(
    viewer: TaskViewer,
    recordingId: string,
    taskIds: readonly string[],
): Promise<TaskView> {
    const ids = [...new Set(taskIds)];
    if (ids.length < 2) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Merge needs two proposals or more",
            400,
            { field: "taskIds" },
        );
    }
    const keepId = await db.transaction(async (tx) => {
        const recording = await lockRecordingForEdit(tx, viewer, recordingId);
        const rows = await tx
            .select()
            .from(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.itemId, recordingId),
                    eq(recordingTasks.status, "proposed"),
                    inArray(recordingTasks.id, ids),
                ),
            );
        if (rows.length !== ids.length) throw notFound();
        const ordered = ids.map((id) => rows.find((row) => row.id === id));
        const [first, ...rest] = ordered;
        if (!first) throw notFound();
        const texts = ordered.map((row) => decryptText(row?.text ?? ""));
        const assigned = ordered.find((row) => row?.assigneePersonId);
        const hinted = ordered.find((row) => row?.assigneeHint);
        const dues = ordered
            .filter((row) => row?.dueDate)
            .sort((a, b) => (a?.dueDate ?? "").localeCompare(b?.dueDate ?? ""));
        const due = dues[0];
        const quoted = ordered.find((row) => row?.quote);
        await tx
            .update(recordingTasks)
            .set({
                text: encryptText(cleanText(texts.join("; "))),
                assigneePersonId: assigned?.assigneePersonId ?? null,
                assigneeCheck: assigned?.assigneeCheck ?? false,
                assigneeHint: assigned ? null : (hinted?.assigneeHint ?? null),
                dueDate: due?.dueDate ?? null,
                duePhrase: due?.duePhrase ?? null,
                quote: quoted?.quote ?? null,
                evidenceStartMs:
                    quoted?.evidenceStartMs ?? first.evidenceStartMs,
                ticked: true,
                source: first.source,
                version: first.version + 1,
                updatedAt: new Date(),
                updatedByUserId: viewer.userId,
            })
            .where(eq(recordingTasks.id, first.id));
        await rejectInTx(
            tx,
            { recordingId, ownerUserId: recording.ownerUserId },
            texts,
        );
        await tx.delete(recordingTasks).where(
            inArray(
                recordingTasks.id,
                rest.map((row) => row?.id ?? ""),
            ),
        );
        return first.id;
    });
    return requireTaskView(viewer, keepId);
}

/** Tick or untick a follow-up of the recording's review. */
export async function tickUpdateProposal(
    viewer: TaskViewer,
    recordingId: string,
    updateId: string,
    ticked: boolean,
    version: number,
): Promise<void> {
    await db.transaction(async (tx) => {
        await lockRecordingForEdit(tx, viewer, recordingId);
        const updated = await tx
            .update(taskUpdateProposals)
            .set({ ticked, version: version + 1, updatedAt: new Date() })
            .where(
                and(
                    eq(taskUpdateProposals.id, updateId),
                    eq(taskUpdateProposals.itemId, recordingId),
                    eq(taskUpdateProposals.version, version),
                ),
            )
            .returning({ id: taskUpdateProposals.id });
        if (updated.length === 0) throw versionConflict();
    });
}

export interface AcceptResult {
    accepted: number;
    rejected: number;
    /** Follow-ups applied, and those skipped (the task moved on, or the viewer may not). */
    updatesApplied: number;
    updatesSkipped: number;
}

/**
 * Finish a recording's review in one transaction: ticked proposals become
 * open tasks, unticked ones are rejected (and remembered), ticked
 * follow-ups apply to their tasks where the viewer may and the task is
 * still open, and every follow-up of the recording goes.
 */
export async function acceptReview(
    viewer: TaskViewer,
    recordingId: string,
    shown?: { proposals: readonly string[]; updates: readonly string[] },
): Promise<AcceptResult> {
    const result = await db.transaction(async (tx) => {
        const recording = await lockRecordingForEdit(tx, viewer, recordingId);
        const proposals = await tx
            .select({
                id: recordingTasks.id,
                text: recordingTasks.text,
                ticked: recordingTasks.ticked,
                version: recordingTasks.version,
                assigneeCheck: recordingTasks.assigneeCheck,
            })
            .from(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.itemId, recordingId),
                    eq(recordingTasks.status, "proposed"),
                ),
            );
        const updates = await tx
            .select({
                id: taskUpdateProposals.id,
                taskId: taskUpdateProposals.taskId,
                kind: taskUpdateProposals.kind,
                dueDate: taskUpdateProposals.dueDate,
                ticked: taskUpdateProposals.ticked,
            })
            .from(taskUpdateProposals)
            .where(
                and(
                    eq(taskUpdateProposals.itemId, recordingId),
                    liveFollowUpCondition(),
                ),
            );
        // Accept what the reviewer saw: a summary made meanwhile replaced
        // the proposals.
        if (
            shown &&
            (!sameIds(
                shown.proposals,
                proposals.map((row) => row.id),
            ) ||
                !sameIds(
                    shown.updates,
                    updates.map((row) => row.id),
                ))
        ) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "The proposals changed meanwhile; review them again",
                409,
            );
        }
        const now = new Date();
        const accepted = proposals.filter((row) => row.ticked);
        const rejected = proposals.filter((row) => !row.ticked);
        // Unticked only because the assignee wanted a look, and never looked
        // at: dropped, but not remembered as a "no".
        const unseen = rejected.filter(
            (row) => row.version === 0 && row.assigneeCheck,
        );
        if (accepted.length > 0) {
            await tx
                .update(recordingTasks)
                .set({
                    status: "open",
                    acceptedAt: now,
                    assignedAt: sql`case when ${recordingTasks.assigneePersonId} is null then null else ${now.toISOString()}::timestamp end`,
                    acceptedByUserId: viewer.userId,
                    updatedAt: now,
                    updatedByUserId: viewer.userId,
                    version: sql`${recordingTasks.version} + 1`,
                })
                .where(
                    inArray(
                        recordingTasks.id,
                        accepted.map((row) => row.id),
                    ),
                );
        }
        if (rejected.length > 0) {
            await rejectInTx(
                tx,
                { recordingId, ownerUserId: recording.ownerUserId },
                rejected
                    .filter((row) => !unseen.includes(row))
                    .map((row) => decryptText(row.text)),
            );
            await tx.delete(recordingTasks).where(
                inArray(
                    recordingTasks.id,
                    rejected.map((row) => row.id),
                ),
            );
        }

        let updatesApplied = 0;
        let updatesSkipped = 0;
        const touched = new Map<string, string>();
        const ticked = updates.filter((row) => row.ticked);
        // The tasks' recordings, locked in one order as every task write
        // locks them, so who may change them holds while they change.
        if (ticked.length > 0) {
            await tx
                .select({ id: recordings.id })
                .from(recordings)
                .where(
                    inArray(
                        recordings.id,
                        tx
                            .select({ id: recordingTasks.itemId })
                            .from(recordingTasks)
                            .where(
                                inArray(
                                    recordingTasks.id,
                                    ticked.map((row) => row.taskId),
                                ),
                            ),
                    ),
                )
                .orderBy(asc(recordings.id))
                .for("update");
        }
        for (const update of ticked) {
            const [target] = await tx
                .select({
                    status: recordingTasks.status,
                    recordingId: recordingTasks.itemId,
                    ownerUserId: recordings.userId,
                    canEdit: sql<boolean>`${taskEditable(viewer)}`,
                    canClose: sql<boolean>`${taskClosable(viewer)}`,
                })
                .from(recordingTasks)
                .innerJoin(recordings, eq(recordings.id, recordingTasks.itemId))
                .where(
                    and(
                        eq(recordingTasks.id, update.taskId),
                        isNull(recordings.deletedAt),
                    ),
                )
                .limit(1);
            const allowed =
                target?.status === "open" &&
                (update.kind === "done" ? target.canClose : target.canEdit);
            if (!target || !allowed) {
                updatesSkipped += 1;
                continue;
            }
            await tx
                .update(recordingTasks)
                .set(
                    update.kind === "done"
                        ? {
                              status: "done",
                              statusChangedAt: now,
                              statusChangedByUserId: viewer.userId,
                              updatedAt: now,
                              updatedByUserId: viewer.userId,
                              version: sql`${recordingTasks.version} + 1`,
                          }
                        : {
                              dueDate: update.dueDate,
                              duePhrase: null,
                              updatedAt: now,
                              updatedByUserId: viewer.userId,
                              version: sql`${recordingTasks.version} + 1`,
                          },
                )
                .where(eq(recordingTasks.id, update.taskId));
            touched.set(target.recordingId, target.ownerUserId);
            updatesApplied += 1;
        }
        await tx
            .delete(taskUpdateProposals)
            .where(eq(taskUpdateProposals.itemId, recordingId));
        return {
            accepted: accepted.length,
            rejected: rejected.length,
            updatesApplied,
            updatesSkipped,
            touched,
            ownerUserId: recording.ownerUserId,
        };
    });
    await tasksChanged(result.ownerUserId, recordingId);
    for (const [other, owner] of result.touched) {
        await tasksChanged(owner, other);
    }
    return {
        accepted: result.accepted,
        rejected: result.rejected,
        updatesApplied: result.updatesApplied,
        updatesSkipped: result.updatesSkipped,
    };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
    const set = new Set(a);
    return set.size === b.length && b.every((id) => set.has(id));
}

async function requireTaskView(
    viewer: TaskViewer,
    taskId: string,
): Promise<TaskView> {
    const [row] = await db
        .select({
            ...taskColumns,
            canEdit: sql<boolean>`${taskEditable(viewer)}`,
            canClose: sql<boolean>`${taskClosable(viewer)}`,
        })
        .from(recordingTasks)
        .innerJoin(recordings, eq(recordings.id, recordingTasks.itemId))
        .leftJoin(people, assigneeJoin())
        .where(and(eq(recordingTasks.id, taskId), taskVisible(viewer)))
        .limit(1);
    if (!row) throw notFound();
    return toView(row);
}

/**
 * Recordings with proposals or follow-ups waiting for the viewer's review,
 * newest first, with how many.
 */
export async function recordingsAwaitingTaskReview(
    viewer: TaskViewer,
): Promise<{ recordingId: string; title: string; proposals: number }[]> {
    const proposals = db
        .select({
            recordingId: recordingTasks.itemId,
            waiting: sql<number>`count(*)`.as("waiting"),
        })
        .from(recordingTasks)
        .where(
            and(
                eq(recordingTasks.status, "proposed"),
                viewer.isOrg
                    ? undefined
                    : eq(recordingTasks.userId, viewer.userId),
            ),
        )
        .groupBy(recordingTasks.itemId);
    const followUps = db
        .select({
            recordingId: taskUpdateProposals.itemId,
            waiting: sql<number>`count(*)`.as("waiting"),
        })
        .from(taskUpdateProposals)
        .where(
            and(
                liveFollowUpCondition(),
                viewer.isOrg
                    ? undefined
                    : eq(taskUpdateProposals.userId, viewer.userId),
            ),
        )
        .groupBy(taskUpdateProposals.itemId);
    const waiting = proposals.unionAll(followUps).as("waiting");
    const rows = await db
        .select({
            recordingId: recordings.id,
            title: chatterItems.title,
            proposals: sql<number>`sum(${waiting.waiting})::int`,
        })
        .from(waiting)
        .innerJoin(recordings, eq(recordings.id, waiting.recordingId))
        .innerJoin(chatterItems, recordingItemJoin)
        .where(and(isNull(recordings.deletedAt), taskEditable(viewer)))
        .groupBy(recordings.id, chatterItems.id)
        .orderBy(desc(chatterItems.occurredAt));
    return rows.map((row) => ({
        recordingId: row.recordingId,
        title: decryptText(row.title),
        proposals: row.proposals,
    }));
}

export type TaskTab = "mine" | "tracked";
export type TaskStateFilter = "open" | "done" | "dropped" | "all";
export type TaskDueFilter = "overdue" | "week" | "none" | null;
export type TaskSort = "created" | "due";

export interface TaskListQuery {
    tab: TaskTab;
    state: TaskStateFilter;
    folderId: string | null;
    due: TaskDueFilter;
    /** The viewer's today, `YYYY-MM-DD`, for the due filters. */
    today: string | null;
    sort: TaskSort;
}

export interface TaskListItem extends TaskView {
    recording: {
        id: string;
        title: string;
        startTime: string;
        /** The view the viewer opens it in. */
        view: "private" | "org";
    };
}

function addDays(day: string, days: number): string {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

/**
 * The viewer's task list. Mine: assigned to them, on their recordings or
 * shared ones. Tracked: everything else on recordings they answer for
 * (their own; for the organization account, the shared ones).
 */
export async function listTasks(
    viewer: TaskViewer,
    query: TaskListQuery,
): Promise<TaskListItem[]> {
    const conditions: (SQL | undefined)[] = [
        ne(recordingTasks.status, "proposed"),
        isNull(recordings.deletedAt),
    ];
    const mine = assignedToViewer(viewer);
    if (query.tab === "mine") {
        if (viewer.isOrg) return [];
        conditions.push(mine, taskVisible(viewer));
    } else {
        conditions.push(
            viewer.isOrg
                ? taskRecordingShared(viewer)
                : and(
                      eq(recordings.userId, viewer.userId),
                      eq(recordingTasks.userId, viewer.userId),
                  ),
            not(mine),
        );
    }
    if (query.state !== "all") {
        conditions.push(eq(recordingTasks.status, query.state));
    }
    if (query.folderId) {
        conditions.push(await folderCondition(viewer.userId, query.folderId));
    }
    if (query.due === "none") {
        conditions.push(isNull(recordingTasks.dueDate));
    } else if (query.due && query.today) {
        conditions.push(
            query.due === "overdue"
                ? lt(recordingTasks.dueDate, query.today)
                : and(
                      gte(recordingTasks.dueDate, query.today),
                      lte(recordingTasks.dueDate, addDays(query.today, 7)),
                  ),
        );
    }

    return loadTaskListItems(
        viewer,
        conditions,
        [
            ...(query.sort === "due"
                ? [
                      sql`${recordingTasks.dueDate} asc nulls last`,
                      desc(recordingTasks.createdAt),
                  ]
                : [desc(recordingTasks.createdAt)]),
            asc(recordingTasks.id),
        ],
        LIST_LIMIT,
    );
}

/** A query of {@link listCallerTasks}. */
export interface CallerTaskQuery {
    status: TaskStateFilter;
    assigneePersonId: string | null;
    recordingId: string | null;
    /** `YYYY-MM-DD`: due strictly before this day; undated tasks drop out. */
    dueBefore: string | null;
    /** SQL over `recordings` the task's recording must also pass. */
    recordingCondition: SQL | null;
    /** Continue after this position of the newest-first order. */
    after: Keyset | null;
    limit: number;
}

function callerTaskConditions(viewer: TaskViewer): SQL[] {
    return [
        ne(recordingTasks.status, "proposed"),
        isNull(recordings.deletedAt),
        taskListed(viewer),
    ];
}

/**
 * Every task in the viewer's lists (the Tasks page's tabs together; never
 * a proposal, never on a deleted recording) that passes the query, newest
 * first (`createdAt`, then `id`), `limit` at most after `after`.
 */
export async function listCallerTasks(
    viewer: TaskViewer,
    query: CallerTaskQuery,
): Promise<TaskListItem[]> {
    const conditions = callerTaskConditions(viewer);
    if (query.status !== "all") {
        conditions.push(eq(recordingTasks.status, query.status));
    }
    if (query.assigneePersonId) {
        conditions.push(
            eq(recordingTasks.assigneePersonId, query.assigneePersonId),
        );
    }
    if (query.recordingId) {
        conditions.push(eq(recordingTasks.itemId, query.recordingId));
    }
    if (query.dueBefore) {
        conditions.push(lt(recordingTasks.dueDate, query.dueBefore));
    }
    if (query.recordingCondition) conditions.push(query.recordingCondition);
    if (query.after) {
        conditions.push(
            keysetBefore(
                recordingTasks.createdAt,
                recordingTasks.id,
                query.after,
            ),
        );
    }
    return loadTaskListItems(
        viewer,
        conditions,
        keysetOrder(recordingTasks.createdAt, recordingTasks.id),
        query.limit,
    );
}

/** One task of the viewer's lists (see {@link listCallerTasks}), or null. */
export async function getCallerTask(
    viewer: TaskViewer,
    taskId: string,
): Promise<TaskListItem | null> {
    const [item] = await loadTaskListItems(
        viewer,
        [...callerTaskConditions(viewer), eq(recordingTasks.id, taskId)],
        [],
        1,
    );
    return item ?? null;
}

async function loadTaskListItems(
    viewer: TaskViewer,
    conditions: readonly (SQL | undefined)[],
    order: readonly SQL[],
    limit: number,
): Promise<TaskListItem[]> {
    const rows = await db
        .select({
            ...taskColumns,
            canEdit: sql<boolean>`${taskEditable(viewer)}`,
            canClose: sql<boolean>`${taskClosable(viewer)}`,
            recordingOwner: recordings.userId,
            recordingTitle: chatterItems.title,
            recordingStart: chatterItems.occurredAt,
        })
        .from(recordingTasks)
        .innerJoin(recordings, eq(recordings.id, recordingTasks.itemId))
        .innerJoin(chatterItems, recordingItemJoin)
        .leftJoin(people, assigneeJoin())
        .where(and(...conditions))
        .orderBy(...order)
        .limit(limit);

    return rows.map((row) => ({
        ...toView(row),
        recording: {
            id: row.recordingId as string,
            title: decryptText(row.recordingTitle),
            startTime: row.recordingStart.toISOString(),
            view: row.recordingOwner === viewer.userId ? "private" : "org",
        },
    }));
}

/** Open tasks assigned to the viewer since they last opened the list. */
export async function countNewTasks(viewer: TaskViewer): Promise<number> {
    if (viewer.isOrg) return 0;
    const [settings] = await db
        .select({ seen: userSettings.tasksSeenAt })
        .from(userSettings)
        .where(eq(userSettings.userId, viewer.userId))
        .limit(1);
    const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(recordingTasks)
        .innerJoin(recordings, eq(recordings.id, recordingTasks.itemId))
        .where(
            and(
                eq(recordingTasks.status, "open"),
                isNull(recordings.deletedAt),
                assignedToViewer(viewer),
                taskVisible(viewer),
                // Their own recording's tasks are not news to them.
                ne(recordings.userId, viewer.userId),
                settings?.seen
                    ? gt(recordingTasks.assignedAt, settings.seen)
                    : undefined,
            ),
        );
    return row?.count ?? 0;
}

/** The viewer opened their task list: the badge starts again from now. */
export async function markTasksSeen(viewer: TaskViewer): Promise<void> {
    const now = new Date();
    // Not everyone has saved settings yet.
    await db
        .insert(userSettings)
        .values({ userId: viewer.userId, tasksSeenAt: now })
        .onConflictDoUpdate({
            target: userSettings.userId,
            set: { tasksSeenAt: now },
        });
}
