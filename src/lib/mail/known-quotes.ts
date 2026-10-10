import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, mailMessages, people, personEmails } from "@/db/schema";
import type { ContentSegment } from "@/lib/content/types";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { readableScopes } from "@/lib/knowledge/scope";
import { messageIdHash } from "@/lib/mail/hash";
import { getOrgUserId } from "@/lib/org/config";

/**
 * The mail of the owner's pile that a new mail's quoted parts repeat, by
 * quote depth: depth 1 is the message it replies to (`In-Reply-To`, the
 * last of `References`), depth 2 the one before. A heuristic: a miss only
 * means a quote is read again.
 */
export async function knownQuotedItems(
    ownerUserId: string,
    references: readonly string[],
    inReplyTo: string | null,
): Promise<Map<number, string>> {
    const chain = [...references];
    if (inReplyTo && chain.at(-1) !== inReplyTo) chain.push(inReplyTo);
    const byDepth = new Map<number, string>();
    if (chain.length === 0) return byDepth;
    const hashes = chain.map((id) => messageIdHash(ownerUserId, id));
    const rows = await db
        .select({ id: mailMessages.id, hash: mailMessages.messageIdHash })
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
                eq(mailMessages.userId, ownerUserId),
                inArray(mailMessages.messageIdHash, hashes),
                isNull(chatterItems.deletedAt),
            ),
        );
    const itemOf = new Map(rows.map((row) => [row.hash, row.id]));
    hashes.forEach((hash, index) => {
        const itemId = itemOf.get(hash);
        if (itemId) byDepth.set(hashes.length - index, itemId);
    });
    return byDepth;
}

/** The segments, each quoted one at a known depth marked as that item. */
export function markKnownQuotes(
    segments: readonly ContentSegment[],
    byDepth: ReadonlyMap<number, string>,
): ContentSegment[] {
    if (byDepth.size === 0) return [...segments];
    return segments.map((segment) => {
        const known =
            segment.depth > 0 &&
            (segment.role === "quoted" || segment.role === "quoted_signature")
                ? byDepth.get(segment.depth)
                : undefined;
        return known ? { ...segment, knownItemId: known } : segment;
    });
}

/**
 * The people the owner reads (their own, and the Organization's) whose
 * email, primary or another of theirs, is one of `addresses`, by address
 * (lowercase): a mail's participants are then those people, the owner's
 * own first. A person merged away stands for the one they became.
 */
export async function peopleByAddress(
    ownerUserId: string,
    addresses: readonly string[],
): Promise<Map<string, string>> {
    const scopes = readableScopes(
        { kind: "recording", ownerUserId, shared: false },
        await getOrgUserId(),
    );
    const byHash = new Map(
        [...new Set(addresses.map((address) => address.toLowerCase()))].map(
            (address) => [lookupHash(address), address] as const,
        ),
    );
    const found = new Map<string, string>();
    if (byHash.size === 0) return found;
    const rows = await db
        .select({
            id: people.id,
            userId: people.userId,
            hash: people.primaryEmailHash,
        })
        .from(people)
        .where(
            and(
                inArray(people.userId, scopes),
                isNull(people.mergedIntoId),
                inArray(people.primaryEmailHash, [...byHash.keys()]),
            ),
        );
    // The owner's own person of an address over the Organization's.
    rows.sort((a, b) =>
        a.userId === ownerUserId ? -1 : b.userId === ownerUserId ? 1 : 0,
    );
    for (const row of rows) {
        const address = row.hash ? byHash.get(row.hash) : undefined;
        if (address && !found.has(address)) found.set(address, row.id);
    }
    const others = await db
        .select({
            hash: personEmails.emailHash,
            id: people.id,
            mergedIntoId: people.mergedIntoId,
        })
        .from(personEmails)
        .innerJoin(people, eq(people.id, personEmails.personId))
        .where(
            and(
                inArray(personEmails.userId, scopes),
                inArray(personEmails.emailHash, [...byHash.keys()]),
            ),
        );
    for (const row of others) {
        const address = byHash.get(row.hash);
        if (address && !found.has(address)) {
            found.set(address, row.mergedIntoId ?? row.id);
        }
    }
    return found;
}
