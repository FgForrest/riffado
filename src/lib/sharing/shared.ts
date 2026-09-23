import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    recordingFolderAssignments,
    recordingFolders,
    recordings,
} from "@/db/schema";

type Executor = Pick<typeof db, "select">;

/** SQL predicate: the recording has at least one Organization folder assignment. */
export function sharedRecordingCondition(orgUserId: string) {
    return sql`exists (
        select 1
        from ${recordingFolderAssignments}
        inner join ${recordingFolders}
            on ${recordingFolders.id} = ${recordingFolderAssignments.folderId}
        where ${recordingFolderAssignments.recordingId} = ${recordings.id}
            and ${recordingFolders.userId} = ${orgUserId}
    )`;
}

/** Whether a recording is currently filed anywhere in the Organization tree. */
export async function isRecordingShared(
    recordingId: string,
    orgUserId: string,
    executor: Executor = db,
): Promise<boolean> {
    const rows = await executor
        .select({ recordingId: recordingFolderAssignments.recordingId })
        .from(recordingFolderAssignments)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .where(
            and(
                eq(recordingFolderAssignments.recordingId, recordingId),
                eq(recordingFolders.userId, orgUserId),
            ),
        )
        .limit(1);
    return rows.length > 0;
}
