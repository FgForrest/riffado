import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    mailAddresses,
    mailDeliveryLog,
    recordingFolders,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import {
    ensureMailbox,
    listUserAddresses,
    type MailAddressKind,
    type MailAddressRow,
    mailUserById,
} from "@/lib/mail/addresses";
import { addressOf, mailDomain } from "@/lib/mail/config";

/** An address as Settings and the folder header show it. */
export interface MailAddressView {
    id: string;
    kind: MailAddressKind;
    address: string;
    label: string | null;
    primary: boolean;
    folderId: string | null;
    baseAddressId: string | null;
    lastReceivedAt: string | null;
    createdAt: string;
    /** The folder's name, on the owner's own folder addresses. */
    folderName?: string;
}

export interface MailSettingsView {
    domain: string;
    /** The user may have addresses: they sign in by single sign-on. */
    eligible: boolean;
    /** Their addresses receive: they signed in recently enough. */
    receiving: boolean;
    addresses: MailAddressView[];
}

export interface DeliveryLogEntry {
    id: string;
    at: string;
    address: string | null;
    senderDomain: string | null;
    outcome: "accepted" | "refused" | "duplicate";
    reason: string | null;
    /** The item it became, while it still exists. */
    itemId: string | null;
}

/** Entries the delivery log page shows at most. */
const DELIVERY_LOG_LIMIT = 200;

/** An address row as the UI shows it. */
export function toAddressView(row: MailAddressRow): MailAddressView {
    return {
        id: row.id,
        kind: row.kind,
        address: addressOf(row.localPart),
        label: row.label,
        primary: row.primary,
        folderId: row.folderId,
        baseAddressId: row.baseAddressId,
        lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
    };
}

/** The user's live addresses: mailbox, personal folder addresses, secrets. */
export async function loadMailSettings(
    userId: string,
): Promise<MailSettingsView> {
    const mailUser = await mailUserById(userId);
    // Eligible since the last backfill: the mailbox comes now.
    if (mailUser) await ensureMailbox(userId);
    const live = (await listUserAddresses(userId)).filter(
        (row) => row.status !== "blocked",
    );
    const folderIds = live.flatMap((row) =>
        row.folderId ? [row.folderId] : [],
    );
    const folders =
        folderIds.length > 0
            ? await db
                  .select({
                      id: recordingFolders.id,
                      name: recordingFolders.name,
                  })
                  .from(recordingFolders)
                  .where(
                      and(
                          eq(recordingFolders.userId, userId),
                          inArray(recordingFolders.id, folderIds),
                      ),
                  )
            : [];
    const nameOf = new Map(
        folders.map((folder) => [folder.id, decryptText(folder.name)]),
    );
    return {
        domain: mailDomain(),
        eligible: mailUser !== null,
        receiving: mailUser?.active ?? false,
        addresses: live.map((row) => {
            const view = toAddressView(row);
            const folderName = row.folderId
                ? nameOf.get(row.folderId)
                : undefined;
            return folderName ? { ...view, folderName } : view;
        }),
    };
}

/** The user's delivery log, newest first. */
export async function loadDeliveryLog(
    userId: string,
): Promise<DeliveryLogEntry[]> {
    const rows = await db
        .select({
            id: mailDeliveryLog.id,
            at: mailDeliveryLog.at,
            localPart: mailAddresses.localPart,
            senderDomain: mailDeliveryLog.senderDomain,
            outcome: mailDeliveryLog.outcome,
            reason: mailDeliveryLog.reason,
            itemId: chatterItems.id,
        })
        .from(mailDeliveryLog)
        .leftJoin(
            mailAddresses,
            eq(mailAddresses.id, mailDeliveryLog.addressId),
        )
        .leftJoin(
            chatterItems,
            and(
                eq(chatterItems.id, mailDeliveryLog.itemId),
                eq(chatterItems.userId, userId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .where(eq(mailDeliveryLog.userId, userId))
        .orderBy(desc(mailDeliveryLog.at))
        .limit(DELIVERY_LOG_LIMIT);
    return rows.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        address: row.localPart ? addressOf(decryptText(row.localPart)) : null,
        senderDomain: row.senderDomain ? decryptText(row.senderDomain) : null,
        outcome: row.outcome,
        reason: row.reason,
        itemId: row.itemId,
    }));
}
