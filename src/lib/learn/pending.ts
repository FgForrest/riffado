/**
 * Where a Learn review waits, for the lists that point at it: the
 * recordings with a run ready for review, and how many. A review is the
 * owner's on their private recordings, and the organization account's on
 * shared ones (Learn's unconfirmed suggestions are theirs alone).
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, learnRuns } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { sharedItemCondition } from "@/lib/sharing/shared";

function waitingFor(viewerUserId: string, viewerIsOrgAccount: boolean) {
    return viewerIsOrgAccount
        ? and(eq(learnRuns.view, "org"), eq(learnRuns.status, "ready"))
        : and(
              eq(learnRuns.view, "private"),
              eq(learnRuns.userId, viewerUserId),
              eq(learnRuns.status, "ready"),
          );
}

/** The recordings with a review waiting for the viewer. */
export async function recordingsNeedingReview(
    viewerUserId: string,
    viewerIsOrgAccount: boolean,
): Promise<Set<string>> {
    const rows = await db
        .selectDistinct({ recordingId: learnRuns.itemId })
        .from(learnRuns)
        .where(waitingFor(viewerUserId, viewerIsOrgAccount));
    return new Set(rows.map((row) => row.recordingId));
}

/** How many reviews wait for the viewer. */
export async function pendingReviewCount(
    viewerUserId: string,
    viewerIsOrgAccount: boolean,
): Promise<number> {
    const [row] = await db
        .select({
            count: sql<number>`count(distinct ${learnRuns.itemId})::int`,
        })
        .from(learnRuns)
        .where(waitingFor(viewerUserId, viewerIsOrgAccount));
    return row?.count ?? 0;
}

/**
 * The recordings a review waits on for the viewer, newest first, with
 * their names: the viewer's own; for the organization account, those
 * shared now, in the same query, so one withdrawn meanwhile is not named.
 */
export async function reviewQueue(
    viewerUserId: string,
    viewerIsOrgAccount: boolean,
): Promise<{ id: string; filename: string; startTime: Date }[]> {
    const rows = await db
        .selectDistinct({
            id: chatterItems.id,
            filename: chatterItems.title,
            startTime: chatterItems.occurredAt,
        })
        .from(learnRuns)
        .innerJoin(chatterItems, eq(chatterItems.id, learnRuns.itemId))
        .where(
            and(
                waitingFor(viewerUserId, viewerIsOrgAccount),
                isNull(chatterItems.deletedAt),
                viewerIsOrgAccount
                    ? sharedItemCondition(viewerUserId)
                    : eq(chatterItems.userId, viewerUserId),
            ),
        )
        .orderBy(desc(chatterItems.occurredAt));
    return rows.map((row) => ({ ...row, filename: decryptText(row.filename) }));
}
