import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, mailAddresses, mailDeliveryLog } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import {
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
}

export interface MailSettingsView {
    domain: string;
    /** The user has a mailbox: they sign in by single sign-on. */
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
    const [rows, mailUser] = await Promise.all([
        listUserAddresses(userId),
        mailUserById(userId),
    ]);
    const live = rows.filter((row) => row.status !== "blocked");
    return {
        domain: mailDomain(),
        eligible: live.some((row) => row.kind === "mailbox"),
        receiving: mailUser?.active ?? false,
        addresses: live.map(toAddressView),
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
