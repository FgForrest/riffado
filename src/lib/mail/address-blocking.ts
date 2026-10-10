import { and, inArray, ne, sql } from "drizzle-orm";
import type { db } from "@/db";
import { mailAddresses } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Blocks every address of the folders `folderIds`, for good: called inside
 * the transaction that deletes them, before the delete.
 */
export async function blockFolderAddressesInTx(
    tx: Tx,
    folderIds: readonly string[],
): Promise<void> {
    if (folderIds.length === 0) return;
    const now = new Date();
    const blocked = await tx
        .update(mailAddresses)
        .set({ status: "blocked", blockedAt: now, updatedAt: now })
        .where(
            and(
                inArray(mailAddresses.folderId, [...folderIds]),
                ne(mailAddresses.status, "blocked"),
            ),
        )
        .returning({ id: mailAddresses.id });
    await blockSecretsOfInTx(
        tx,
        blocked.map((row) => row.id),
    );
}

/** Blocks the secret addresses extending `baseIds`. */
export async function blockSecretsOfInTx(
    tx: Tx,
    baseIds: readonly string[],
): Promise<void> {
    if (baseIds.length === 0) return;
    const now = new Date();
    await tx
        .update(mailAddresses)
        .set({ status: "blocked", blockedAt: now, updatedAt: now })
        .where(
            and(
                inArray(mailAddresses.baseAddressId, [...baseIds]),
                ne(mailAddresses.status, "blocked"),
            ),
        );
}

/**
 * Blocks every address in a user's namespace and every one they created:
 * called inside the transaction that deletes the account, before it.
 */
export async function blockUserAddressesInTx(
    tx: Tx,
    userId: string,
): Promise<void> {
    const now = new Date();
    const blocked = await tx
        .update(mailAddresses)
        .set({ status: "blocked", blockedAt: now, updatedAt: now })
        .where(
            and(
                sql`(${mailAddresses.namespaceUserId} = ${userId} or (${mailAddresses.kind} = 'secret' and ${mailAddresses.createdByUserId} = ${userId}))`,
                ne(mailAddresses.status, "blocked"),
            ),
        )
        .returning({ id: mailAddresses.id });
    await blockSecretsOfInTx(
        tx,
        blocked.map((row) => row.id),
    );
}
