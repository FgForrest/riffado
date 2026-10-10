import { and, count, eq } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    mailMessages,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
} from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { lockOrgTree, orgTreeChanged } from "@/lib/folders/folders";
import { deleteRawMail } from "@/lib/mail/raw-storage";
import { shareMailInTx } from "@/lib/mail/share-gate";
import { getOrgUserId } from "@/lib/org/config";

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
 * Deletes the owner's mail for good: the item and everything on it (its
 * participants, segments, folder assignments, pending shares) in one
 * transaction, then the encrypted raw message.
 */
export async function deleteMail(
    ownerUserId: string,
    itemId: string,
): Promise<void> {
    let rawPath: string | null = null;
    let wasShared = false;
    const orgUserId = await getOrgUserId();
    await db.transaction(async (tx) => {
        if (orgUserId) await lockOrgTree(tx);
        await lockMailInTx(tx, ownerUserId, itemId);
        const [message] = await tx
            .select({ path: mailMessages.rawStoragePath })
            .from(mailMessages)
            .where(
                and(
                    eq(mailMessages.id, itemId),
                    eq(mailMessages.userId, ownerUserId),
                ),
            )
            .limit(1);
        rawPath = message?.path ?? null;
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
        await tx
            .delete(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, ownerUserId),
                ),
            );
    });
    if (rawPath) await deleteRawMail(ownerUserId, rawPath);
    if (wasShared) await orgTreeChanged();
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
        await shareMailInTx(tx, input);
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
