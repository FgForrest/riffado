import { and, count, eq } from "drizzle-orm";
import type { db } from "@/db";
import {
    learnRuns,
    mailPendingShares,
    recordingFolderAssignments,
    recordingTasks,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { learnRunOpen } from "@/lib/learn/learn-open";
import type { ShareGateProblem } from "@/lib/sharing/share-gate";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What keeps a mail out of the Organization (D2): a Learn run still open
 * on it, or a task proposal undecided. Empty when it may be shared.
 */
export async function mailShareProblems(
    tx: Tx,
    itemId: string,
): Promise<ShareGateProblem[]> {
    const [[openRuns], [proposals]] = await Promise.all([
        tx
            .select({ n: count() })
            .from(learnRuns)
            .where(and(eq(learnRuns.itemId, itemId), learnRunOpen())),
        tx
            .select({ n: count() })
            .from(recordingTasks)
            .where(
                and(
                    eq(recordingTasks.itemId, itemId),
                    eq(recordingTasks.status, "proposed"),
                ),
            ),
    ]);
    const problems: ShareGateProblem[] = [];
    if ((openRuns?.n ?? 0) > 0) {
        problems.push({ kind: "learn_unfinished", runs: openRuns?.n ?? 0 });
    }
    if ((proposals?.n ?? 0) > 0) {
        problems.push({
            kind: "tasks_unreviewed",
            proposals: proposals?.n ?? 0,
        });
    }
    return problems;
}

/**
 * Shares the owner's mail into an Organization folder in the caller's
 * transaction, which holds the Organization tree lock and the item's: the
 * gate first, then the assignment; a wish to share it there is fulfilled.
 */
export async function shareMailInTx(
    tx: Tx,
    input: { ownerUserId: string; itemId: string; folderId: string },
): Promise<void> {
    const problems = await mailShareProblems(tx, input.itemId);
    if (problems.length > 0) {
        throw new AppError(
            ErrorCode.SHARE_REQUIREMENTS_UNMET,
            "Finish the review before sharing",
            409,
            { problems },
        );
    }
    await tx
        .insert(recordingFolderAssignments)
        .values({
            userId: input.ownerUserId,
            itemId: input.itemId,
            folderId: input.folderId,
        })
        .onConflictDoNothing();
    await tx
        .delete(mailPendingShares)
        .where(
            and(
                eq(mailPendingShares.itemId, input.itemId),
                eq(mailPendingShares.userId, input.ownerUserId),
                eq(mailPendingShares.folderId, input.folderId),
            ),
        );
}
