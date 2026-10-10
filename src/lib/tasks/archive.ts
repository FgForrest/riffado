import { and, eq, inArray, ne, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    people,
    recordingTasks,
    taskUpdateProposals,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import {
    type ArchiveScope,
    archivedItemCondition,
} from "@/lib/export/archive-scope";

/** One task as a backup archive carries it. */
export interface ArchivedTask {
    id: string;
    status: "proposed" | "open" | "done" | "dropped";
    text: string;
    assignee: { personId: string; name: string } | null;
    assigneeHint: string | null;
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
    /** On a mail: the segment and range of its text the quote is in. */
    evidenceText?: {
        segmentIndex: number;
        charStart: number;
        charEnd: number;
    };
    evidenceProvenance?: "quoted" | "unverified";
    source: string;
    createdAt: string;
    acceptedAt: string | null;
    statusChangedAt: string | null;
    /** A proposal's review so far: kept or not, and whether its assignee needs a check. */
    review?: { ticked: boolean; assigneeCheck: boolean };
}

/** A change to an earlier task heard on a recording, waiting for review. */
export interface ArchivedTaskUpdate {
    id: string;
    /** The task it changes: in the same archive. */
    taskId: string;
    kind: "done" | "due";
    dueDate: string | null;
    duePhrase: string | null;
    quote: string | null;
    evidenceStartMs: number | null;
    ticked: boolean;
    createdAt: string;
}

function optional(value: string | null): string | null {
    return value ? decryptText(value) : null;
}

/**
 * Whose tasks an archive or a Markdown document carries: a backup's scope,
 * or every task of the owner's recordings (`owner`, the documents rendered
 * from the owner's rows).
 */
export type TaskArchiveScope = ArchiveScope | { kind: "owner"; userId: string };

// A person's own: on a recording they shared, the tasks the summaries
// proposed and those they added, not those the Organization added by hand.
// The Organization's: every task of the shared recordings it carries.
function archivedTaskCondition(scope: TaskArchiveScope): SQL | undefined {
    if (scope.kind === "organization") {
        return archivedItemCondition(scope);
    }
    if (scope.kind === "owner") return eq(recordingTasks.userId, scope.userId);
    return and(
        eq(recordingTasks.userId, scope.userId),
        or(
            ne(recordingTasks.source, "manual"),
            eq(recordingTasks.createdByUserId, scope.userId),
        ),
    );
}

/**
 * The tasks of `recordingIds` a scope carries, by recording, for backup
 * archives and exports. Proposals waiting for review come along only with
 * `proposals` (a backup); a document lists accepted tasks.
 */
export async function tasksForArchive(
    scope: TaskArchiveScope,
    recordingIds: readonly string[],
    { proposals = false }: { proposals?: boolean } = {},
): Promise<Map<string, ArchivedTask[]>> {
    const byRecording = new Map<string, ArchivedTask[]>();
    if (recordingIds.length === 0) return byRecording;
    const rows = await db
        .select({
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
            evidenceSegmentIndex: recordingTasks.evidenceSegmentIndex,
            evidenceCharStart: recordingTasks.evidenceCharStart,
            evidenceCharEnd: recordingTasks.evidenceCharEnd,
            evidenceProvenance: recordingTasks.evidenceProvenance,
            source: recordingTasks.source,
            ticked: recordingTasks.ticked,
            createdAt: recordingTasks.createdAt,
            acceptedAt: recordingTasks.acceptedAt,
            statusChangedAt: recordingTasks.statusChangedAt,
        })
        .from(recordingTasks)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, recordingTasks.itemId),
                eq(chatterItems.userId, recordingTasks.userId),
            ),
        )
        .leftJoin(people, eq(people.id, recordingTasks.assigneePersonId))
        .where(
            and(
                archivedTaskCondition(scope),
                inArray(recordingTasks.itemId, [...recordingIds]),
                proposals ? undefined : ne(recordingTasks.status, "proposed"),
            ),
        )
        .orderBy(recordingTasks.position, recordingTasks.createdAt);
    for (const row of rows) {
        const list = byRecording.get(row.recordingId) ?? [];
        const status = row.status as ArchivedTask["status"];
        list.push({
            id: row.id,
            status,
            text: decryptText(row.text),
            assignee:
                row.assigneePersonId && row.assigneeName
                    ? {
                          personId: row.assigneePersonId,
                          name: decryptText(row.assigneeName),
                      }
                    : null,
            assigneeHint: optional(row.assigneeHint),
            dueDate: row.dueDate,
            duePhrase: optional(row.duePhrase),
            quote: optional(row.quote),
            evidenceStartMs: row.evidenceStartMs,
            ...(row.evidenceSegmentIndex !== null &&
            row.evidenceCharStart !== null &&
            row.evidenceCharEnd !== null
                ? {
                      evidenceText: {
                          segmentIndex: row.evidenceSegmentIndex,
                          charStart: row.evidenceCharStart,
                          charEnd: row.evidenceCharEnd,
                      },
                  }
                : {}),
            ...(row.evidenceProvenance
                ? { evidenceProvenance: row.evidenceProvenance }
                : {}),
            source: row.source,
            createdAt: row.createdAt.toISOString(),
            acceptedAt: row.acceptedAt?.toISOString() ?? null,
            statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
            ...(status === "proposed"
                ? {
                      review: {
                          ticked: row.ticked,
                          assigneeCheck: row.assigneeCheck,
                      },
                  }
                : {}),
        });
        byRecording.set(row.recordingId, list);
    }
    return byRecording;
}

/**
 * The follow-ups heard on `recordingIds` and waiting for review, by the
 * recording they were heard on: only those whose task the same archive
 * carries (`archivedTaskIds`), so none points at someone else's task.
 */
export async function taskUpdatesForArchive(
    scope: ArchiveScope,
    recordingIds: readonly string[],
    archivedTaskIds: ReadonlySet<string>,
): Promise<Map<string, ArchivedTaskUpdate[]>> {
    const byRecording = new Map<string, ArchivedTaskUpdate[]>();
    if (recordingIds.length === 0 || archivedTaskIds.size === 0) {
        return byRecording;
    }
    const rows = await db
        .select({
            id: taskUpdateProposals.id,
            recordingId: taskUpdateProposals.itemId,
            taskId: taskUpdateProposals.taskId,
            kind: taskUpdateProposals.kind,
            dueDate: taskUpdateProposals.dueDate,
            duePhrase: taskUpdateProposals.duePhrase,
            quote: taskUpdateProposals.quote,
            evidenceStartMs: taskUpdateProposals.evidenceStartMs,
            ticked: taskUpdateProposals.ticked,
            createdAt: taskUpdateProposals.createdAt,
        })
        .from(taskUpdateProposals)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, taskUpdateProposals.itemId),
                eq(chatterItems.userId, taskUpdateProposals.userId),
            ),
        )
        .where(
            and(
                scope.kind === "personal"
                    ? eq(taskUpdateProposals.userId, scope.userId)
                    : archivedItemCondition(scope),
                inArray(taskUpdateProposals.itemId, [...recordingIds]),
            ),
        )
        .orderBy(taskUpdateProposals.createdAt);
    for (const row of rows) {
        if (!archivedTaskIds.has(row.taskId)) continue;
        const list = byRecording.get(row.recordingId) ?? [];
        list.push({
            id: row.id,
            taskId: row.taskId,
            kind: row.kind,
            dueDate: row.dueDate,
            duePhrase: optional(row.duePhrase),
            quote: optional(row.quote),
            evidenceStartMs: row.evidenceStartMs,
            ticked: row.ticked,
            createdAt: row.createdAt.toISOString(),
        });
        byRecording.set(row.recordingId, list);
    }
    return byRecording;
}

/** The people the archived tasks are assigned to. */
export function archivedAssigneeIds(
    tasks: Iterable<readonly ArchivedTask[]>,
): string[] {
    const ids = new Set<string>();
    for (const list of tasks) {
        for (const task of list) {
            if (task.assignee) ids.add(task.assignee.personId);
        }
    }
    return [...ids];
}
