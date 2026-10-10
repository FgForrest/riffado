import { type AnyColumn, and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
} from "@/db/schema";

type Executor = Pick<typeof db, "select">;

/**
 * SQL predicate: the item `itemId` names (a `chatter_items` row by
 * default) has at least one Organization folder assignment.
 */
export function sharedItemCondition(
    orgUserId: string,
    itemId: AnyColumn = chatterItems.id,
) {
    return sql`exists (
        select 1
        from ${recordingFolderAssignments}
        inner join ${recordingFolders}
            on ${recordingFolders.id} = ${recordingFolderAssignments.folderId}
        where ${recordingFolderAssignments.itemId} = ${itemId}
            and ${recordingFolders.userId} = ${orgUserId}
    )`;
}

/** SQL predicate: the recording has at least one Organization folder assignment. */
export function sharedRecordingCondition(orgUserId: string) {
    return sharedItemCondition(orgUserId, recordings.id);
}

/** Whether a recording is currently filed anywhere in the Organization tree. */
export async function isRecordingShared(
    recordingId: string,
    orgUserId: string,
    executor: Executor = db,
): Promise<boolean> {
    const rows = await executor
        .select({ recordingId: recordingFolderAssignments.itemId })
        .from(recordingFolderAssignments)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .where(
            and(
                eq(recordingFolderAssignments.itemId, recordingId),
                eq(recordingFolders.userId, orgUserId),
            ),
        )
        .limit(1);
    return rows.length > 0;
}
