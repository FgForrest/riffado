import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
    asyncJobs,
    chatterItems,
    mailMessages,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import { lockOrgTree, orgTreeChanged } from "@/lib/folders/folders";
import {
    knowledgeOnRecordingInTx,
    pruneUnsupportedFactsInTx,
} from "@/lib/knowledge/fact-evidence";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { deleteRawMail } from "@/lib/mail/raw-storage";
import { shareMailInTx } from "@/lib/mail/share-gate";
import { getOrgUserId } from "@/lib/org/config";
import { recordingJobSubject } from "@/lib/sharing/view";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function mailNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Mail not found", 404);
}

/** Locks the owner's live mail item; throws 404 when there is none. */
async function lockMailInTx(
    tx: Tx,
    ownerUserId: string,
    itemId: string,
): Promise<void> {
    const [item] = await tx
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, ownerUserId),
                eq(chatterItems.kind, "mail"),
            ),
        )
        .for("update")
        .limit(1);
    if (!item) throw mailNotFound();
}

/**
 * Deletes the owner's mail for good. The encrypted raw message goes first,
 * as a recording's audio does: when storage fails nothing else changed and
 * the owner can retry, and no message is left behind without its row. Then
 * the item and everything on it (participants, segments, folder
 * assignments, pending shares, evidence) in one transaction, with the
 * facts it was the only evidence of, and the jobs queued for it.
 */
export async function deleteMail(
    ownerUserId: string,
    itemId: string,
): Promise<void> {
    const [message] = await db
        .select({ path: mailMessages.rawStoragePath })
        .from(mailMessages)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, mailMessages.id),
                eq(chatterItems.userId, mailMessages.userId),
            ),
        )
        .where(
            and(
                eq(mailMessages.id, itemId),
                eq(mailMessages.userId, ownerUserId),
            ),
        )
        .limit(1);
    if (!message) throw mailNotFound();
    if (message.path) {
        try {
            await deleteRawMail(ownerUserId, message.path);
        } catch (error) {
            console.error(
                `[mail] could not delete the raw message of mail ${itemId}:`,
                error instanceof Error ? error.message : error,
            );
            throw new AppError(
                ErrorCode.STORAGE_ERROR,
                "The mail could not be deleted from storage. Please retry.",
                500,
            );
        }
    }
    let wasShared = false;
    const orgUserId = await getOrgUserId();
    await db.transaction(async (tx) => {
        if (orgUserId) await lockOrgTree(tx);
        await lockMailInTx(tx, ownerUserId, itemId);
        if (orgUserId) {
            const [shared] = await tx
                .select({ n: count() })
                .from(recordingFolderAssignments)
                .innerJoin(
                    recordingFolders,
                    eq(
                        recordingFolders.id,
                        recordingFolderAssignments.folderId,
                    ),
                )
                .where(
                    and(
                        eq(recordingFolderAssignments.itemId, itemId),
                        eq(recordingFolders.userId, orgUserId),
                    ),
                );
            wasShared = (shared?.n ?? 0) > 0;
        }
        const now = new Date();
        await tx
            .update(asyncJobs)
            .set({
                status: "failed",
                completedAt: now,
                updatedAt: now,
                heartbeatAt: null,
                claimToken: null,
                errorCode: ErrorCode.RECORDING_NOT_FOUND,
                lastError: "Cancelled because the mail was deleted",
            })
            .where(
                and(
                    inArray(asyncJobs.subjectId, [
                        recordingJobSubject(itemId, "private"),
                        recordingJobSubject(itemId, "org"),
                    ]),
                    inArray(asyncJobs.kind, ["summary", "learn.run"]),
                    inArray(asyncJobs.status, ["pending", "processing"]),
                ),
            );
        const knowledge = await knowledgeOnRecordingInTx(tx, itemId);
        await tx
            .delete(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, ownerUserId),
                ),
            );
        await pruneUnsupportedFactsInTx(tx, knowledge.factIds);
        await bumpScopeInTx(tx, knowledge.scopes);
    });
    if (wasShared) await orgTreeChanged();
    // What the owner's exports wrote of it goes too.
    await enqueueExportPlansForUser(ownerUserId).catch((error: unknown) => {
        console.error(
            "[mail] could not schedule folder exports:",
            error instanceof Error ? error.message : error,
        );
    });
}

/**
 * Shares the owner's mail into the Organization folder it was sent to
 * (D2): only a folder it waits for, and only once its review is done (no
 * Learn run open, no task proposal undecided).
 */
export async function shareMail(input: {
    ownerUserId: string;
    itemId: string;
    folderId: string;
}): Promise<void> {
    const orgUserId = await getOrgUserId();
    if (!orgUserId) throw mailNotFound();
    await db.transaction(async (tx) => {
        await lockOrgTree(tx);
        // Before the item: sharing promotes people, and a promotion may
        // merge them, which locks items.
        await lockOrgPeople(tx);
        await lockMailInTx(tx, input.ownerUserId, input.itemId);
        const [pending] = await tx
            .select({ folderId: mailPendingShares.folderId })
            .from(mailPendingShares)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, mailPendingShares.folderId),
            )
            .where(
                and(
                    eq(mailPendingShares.itemId, input.itemId),
                    eq(mailPendingShares.userId, input.ownerUserId),
                    eq(mailPendingShares.folderId, input.folderId),
                    eq(recordingFolders.userId, orgUserId),
                ),
            )
            .limit(1);
        if (!pending) throw mailNotFound();
        await shareMailInTx(tx, { ...input, orgUserId });
    });
    await orgTreeChanged();
}

/** Drops a pending share: the mail stays in the owner's pile only. */
export async function dismissPendingShare(input: {
    ownerUserId: string;
    itemId: string;
    folderId: string;
}): Promise<void> {
    await db
        .delete(mailPendingShares)
        .where(
            and(
                eq(mailPendingShares.itemId, input.itemId),
                eq(mailPendingShares.userId, input.ownerUserId),
                eq(mailPendingShares.folderId, input.folderId),
            ),
        );
}
