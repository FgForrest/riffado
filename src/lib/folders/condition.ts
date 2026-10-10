import { and, eq, exists, inArray, type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import { recordingFolderAssignments, recordings } from "@/db/schema";
import { listFolderOrganization } from "@/lib/folders/folders";
import { descendantFolderIds } from "@/lib/folders/hierarchy";
import type { FolderOrganization } from "@/types/folder";

/**
 * SQL over `recordings`: those filed in `folderId` or below it, in the tree
 * `userId` sees (`organization`). The Private root holds every recording
 * of its owner. Null when the folder is not in that tree.
 */
export function folderRecordingCondition(
    organization: FolderOrganization,
    userId: string,
    folderId: string,
): SQL | null {
    const folder = organization.folders.find((entry) => entry.id === folderId);
    if (!folder) return null;
    if (folder.kind === "private") return eq(recordings.userId, userId);
    const ids = [...descendantFolderIds(organization.folders, folderId)];
    return exists(
        db
            .select({ one: sql`1` })
            .from(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, recordings.id),
                    inArray(recordingFolderAssignments.folderId, ids),
                ),
            ),
    );
}

/**
 * A folder filter: the recordings filed in it or below, as `userId` sees
 * the tree; nothing for a folder they do not see.
 */
export async function folderCondition(
    userId: string,
    folderId: string,
): Promise<SQL> {
    const organization = await listFolderOrganization(userId);
    return (
        folderRecordingCondition(organization, userId, folderId) ?? sql`false`
    );
}
