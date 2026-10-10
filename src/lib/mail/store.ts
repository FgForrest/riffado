import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import {
    chatterItems,
    mailContents,
    mailDeliveryLog,
    mailMessages,
    mailParticipants,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { touchAddress } from "@/lib/mail/addresses";
import { summarizeAuth } from "@/lib/mail/dkim";
import {
    messageIdHash,
    participantAddressHash,
    rawMessageHash,
} from "@/lib/mail/hash";
import {
    knownQuotedItems,
    markKnownQuotes,
    peopleByAddress,
} from "@/lib/mail/known-quotes";
import type { ParsedMessage } from "@/lib/mail/parse";
import type { MessageFacts } from "@/lib/mail/policy";
import { deleteRawMail, storeRawMail } from "@/lib/mail/raw-storage";
import { MAIL_PARSER_VERSION, segmentMail } from "@/lib/mail/segment";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What one owner receives of a message, from every recipient of theirs. */
export interface OwnerDelivery {
    ownerUserId: string;
    senderVerified: boolean;
    /** Their own folders it is filed into. */
    folderIds: string[];
    /** Organization folders it waits to be shared into (D2). */
    pendingShareFolderIds: string[];
    /** The addresses that accepted it. */
    addresses: string[];
    recipients: string[];
}

const MAX_CLAIMED_DAYS_BACK = 30;

/**
 * When the item happened: the Date header when it is plausible, else when
 * it arrived. A forged date must not pin a mail to the top of the pile.
 */
function occurredAt(sentAt: Date | null, receivedAt: Date): Date {
    if (!sentAt) return receivedAt;
    const earliest = receivedAt.getTime() - MAX_CLAIMED_DAYS_BACK * 86_400_000;
    const latest = receivedAt.getTime() + 86_400_000;
    const at = sentAt.getTime();
    return at >= earliest && at <= latest ? sentAt : receivedAt;
}

function isUniqueViolation(error: unknown): boolean {
    const value = error as { code?: unknown; cause?: { code?: unknown } };
    return value?.code === "23505" || value?.cause?.code === "23505";
}

/** Files an item into the owner's folders and pending shares, idempotently. */
async function fileInTx(
    tx: Tx,
    delivery: OwnerDelivery,
    itemId: string,
): Promise<void> {
    const folderIds = [...new Set(delivery.folderIds)];
    if (folderIds.length > 0) {
        const owned = await tx
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    inArray(recordingFolders.id, folderIds),
                    eq(recordingFolders.userId, delivery.ownerUserId),
                ),
            );
        if (owned.length > 0) {
            await tx
                .insert(recordingFolderAssignments)
                .values(
                    owned.map((folder) => ({
                        userId: delivery.ownerUserId,
                        itemId,
                        folderId: folder.id,
                    })),
                )
                .onConflictDoNothing();
        }
    }
    const pending = [...new Set(delivery.pendingShareFolderIds)];
    if (pending.length > 0) {
        await tx
            .insert(mailPendingShares)
            .values(
                pending.map((folderId) => ({
                    itemId,
                    userId: delivery.ownerUserId,
                    folderId,
                })),
            )
            .onConflictDoNothing();
    }
}

async function logAcceptedInTx(
    tx: Tx,
    delivery: OwnerDelivery,
    itemId: string,
    outcome: "accepted" | "duplicate",
    facts: MessageFacts,
    at: Date,
): Promise<void> {
    const from = facts.fromAddresses[0];
    const domain = from ? from.slice(from.lastIndexOf("@") + 1) : null;
    const addresses = [...new Set(delivery.addresses)];
    await tx.insert(mailDeliveryLog).values(
        (addresses.length > 0 ? addresses : [null]).map((addressId) => ({
            userId: delivery.ownerUserId,
            at,
            addressId,
            senderDomain: domain ? encryptText(domain) : null,
            outcome,
            itemId,
        })),
    );
    for (const addressId of addresses) await touchAddress(tx, addressId, at);
}

async function existingItem(
    executor: Tx | typeof db,
    ownerUserId: string,
    rawHash: string,
): Promise<string | null> {
    const [row] = await executor
        .select({ id: mailMessages.id })
        .from(mailMessages)
        .where(
            and(
                eq(mailMessages.userId, ownerUserId),
                eq(mailMessages.rawHash, rawHash),
            ),
        )
        .limit(1);
    return row?.id ?? null;
}

/**
 * Stores a message for one owner, or, when they have it already (a retry,
 * or another recipient of the same message), files the stored item into
 * this delivery's folders too.
 */
export async function storeMailForOwner(input: {
    delivery: OwnerDelivery;
    raw: Buffer;
    parsed: ParsedMessage;
    facts: MessageFacts;
    spf: string | null;
    receivedAt: Date;
}): Promise<{ itemId: string; duplicate: boolean }> {
    const { delivery, parsed, receivedAt } = input;
    const owner = delivery.ownerUserId;
    const rawHash = rawMessageHash(owner, input.raw);

    const merge = async (itemId: string) => {
        await db.transaction(async (tx) => {
            await fileInTx(tx, delivery, itemId);
            await logAcceptedInTx(
                tx,
                delivery,
                itemId,
                "duplicate",
                input.facts,
                receivedAt,
            );
        });
        return { itemId, duplicate: true };
    };

    const known = await existingItem(db, owner, rawHash);
    if (known) return merge(known);

    const itemId = nanoid();
    const segmented = segmentMail({
        text: parsed.text,
        html: parsed.html,
        from: parsed.from[0] ?? null,
        sender: parsed.sender,
        to: parsed.to,
        cc: parsed.cc,
        replyTo: parsed.replyTo,
        sentAt: parsed.sentAt,
        fromAuthenticated: delivery.senderVerified,
    });
    const threadRoot =
        parsed.references[0] ?? parsed.inReplyTo ?? parsed.messageId;
    const [knownQuotes, participantPeople] = await Promise.all([
        knownQuotedItems(owner, parsed.references, parsed.inReplyTo),
        peopleByAddress(
            owner,
            segmented.participants.flatMap((participant) =>
                participant.address ? [participant.address] : [],
            ),
        ),
    ]);
    const segments = markKnownQuotes(segmented.segments, knownQuotes);
    const rawStoragePath = await storeRawMail(owner, itemId, input.raw);
    try {
        await db.transaction(async (tx) => {
            await tx.insert(chatterItems).values({
                id: itemId,
                userId: owner,
                kind: "mail",
                title: encryptText(parsed.subject),
                occurredAt: occurredAt(parsed.sentAt, receivedAt),
                createdAt: receivedAt,
                updatedAt: receivedAt,
            });
            await tx.insert(mailMessages).values({
                id: itemId,
                userId: owner,
                addressId: delivery.addresses[0] ?? null,
                rawHash,
                messageIdHash: parsed.messageId
                    ? messageIdHash(owner, parsed.messageId)
                    : null,
                threadKeyHash: threadRoot
                    ? messageIdHash(owner, threadRoot)
                    : null,
                sentAt: parsed.sentAt,
                receivedAt,
                sizeBytes: input.raw.length,
                rawStoragePath,
                auth: encryptJsonField(
                    summarizeAuth(
                        input.facts,
                        input.spf,
                        delivery.senderVerified,
                    ),
                ),
                senderVerified: delivery.senderVerified,
                autoGenerated: parsed.autoGenerated,
                unreadable: parsed.unreadable,
                attachments:
                    parsed.attachments.length > 0
                        ? encryptJsonField(parsed.attachments)
                        : null,
                createdAt: receivedAt,
                updatedAt: receivedAt,
            });
            if (segmented.participants.length > 0) {
                await tx.insert(mailParticipants).values(
                    segmented.participants.map((participant, position) => ({
                        itemId,
                        userId: owner,
                        ref: participant.ref,
                        roles: [...participant.roles],
                        addressHash: participant.address
                            ? participantAddressHash(participant.address)
                            : null,
                        address: participant.address
                            ? encryptText(participant.address)
                            : null,
                        name: participant.displayName
                            ? encryptText(participant.displayName)
                            : null,
                        personId: participant.address
                            ? (participantPeople.get(
                                  participant.address.toLowerCase(),
                              ) ?? null)
                            : null,
                        authenticated: participant.authenticated,
                        position,
                    })),
                );
            }
            await tx.insert(mailContents).values({
                itemId,
                userId: owner,
                revision: 0,
                parserVersion: MAIL_PARSER_VERSION,
                segments: encryptJsonField(segments),
            });
            await fileInTx(tx, delivery, itemId);
            await logAcceptedInTx(
                tx,
                delivery,
                itemId,
                "accepted",
                input.facts,
                receivedAt,
            );
        });
    } catch (error) {
        await deleteRawMail(owner, rawStoragePath).catch(() => undefined);
        if (isUniqueViolation(error)) {
            // The same message stored meanwhile by a concurrent delivery.
            const raced = await existingItem(db, owner, rawHash);
            if (raced) return merge(raced);
        }
        throw error;
    }
    return { itemId, duplicate: false };
}
