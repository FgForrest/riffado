/**
 * Inbound mail, from the receiver's hand-off to stored items.
 *
 * Two steps, so unauthenticated junk never reaches the MIME parser:
 * `precheckMail` judges the receiver's metadata (its own DKIM results, the
 * From mailboxes, the recipients) and says which recipients would pass;
 * only then does the receiver send the message, and `ingestMail` verifies
 * DKIM again itself (the receiver's verdict is never trusted), parses,
 * applies the policy again and stores. Every recipient at the mail domain
 * gets the same SMTP answer whatever happened (D7); refusals land in the
 * delivery log of whoever owns the address.
 */

import { and, count, eq, gte } from "drizzle-orm";
import type { DNSResolver } from "mailauth";
import { db } from "@/db";
import {
    mailAddresses,
    mailDeliveryLog,
    mailMessages,
    users,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import {
    type MailAddressRow,
    mailUserByEmail,
    mailUserById,
    resolveLocalPart,
} from "@/lib/mail/addresses";
import { isMailEnabled, mailDomain } from "@/lib/mail/config";
import { authenticateMessage } from "@/lib/mail/dkim";
import { parseMessage } from "@/lib/mail/parse";
import {
    evaluateRecipient,
    type MailUser,
    type MessageFacts,
    type RecipientTarget,
    type RecipientVerdict,
    type RefusalReason,
} from "@/lib/mail/policy";
import { type OwnerDelivery, storeMailForOwner } from "@/lib/mail/store";

/** Recipients one message may name (RFC 5321). */
export const MAX_RECIPIENTS = 100;

export type RecipientOutcome =
    | "accepted"
    | "duplicate"
    | "refused"
    | "quota"
    | "not_ours";

export interface PrecheckInput {
    recipients: readonly string[];
    facts: MessageFacts;
}

export interface IngestInput {
    raw: Buffer;
    recipients: readonly string[];
    /** The receiver's SPF result: kept for display, never authorizes. */
    spf: string | null;
    receivedAt: Date;
    /** Replaces DNS for DKIM keys (tests). */
    resolver?: DNSResolver;
}

export interface IngestResult {
    outcomes: { recipient: string; outcome: RecipientOutcome }[];
    /** Some owner is over their daily limit: answer 452, Google retries. */
    overQuota: boolean;
}

interface Resolved {
    recipient: string;
    address: MailAddressRow | null;
    target: RecipientTarget | null;
    /** Whose delivery log hears of a refusal. */
    logUserId: string | null;
}

function localPartOf(recipient: string): string | null {
    const at = recipient.lastIndexOf("@");
    if (at <= 0) return null;
    const domain = recipient.slice(at + 1).toLowerCase();
    return domain === mailDomain() ? recipient.slice(0, at) : null;
}

function domainOf(address: string | undefined): string | null {
    if (!address) return null;
    return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** The distinct recipients at the mail domain, lowercase, in order. */
function ourRecipients(recipients: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const recipient of recipients.slice(0, MAX_RECIPIENTS)) {
        const normalized = recipient.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        if (localPartOf(normalized) !== null) out.push(normalized);
    }
    return out;
}

async function isOrgAccount(userId: string): Promise<boolean> {
    const [row] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    return row?.role === "org";
}

/** What a recipient address files into, as the policy sees it. */
async function resolveRecipient(
    recipient: string,
    now: Date,
): Promise<Resolved> {
    const localPart = localPartOf(recipient);
    const address = localPart ? await resolveLocalPart(localPart) : null;
    const none = { recipient, address, target: null, logUserId: null };
    if (!address || address.status === "blocked" || !address.namespaceUserId) {
        return none;
    }
    const logUserId = address.namespaceUserId;
    if (address.status === "paused") return { ...none, logUserId };
    if (address.kind === "folder" && (await isOrgAccount(logUserId))) {
        return {
            recipient,
            address,
            target: { kind: "organization", address: recipient },
            logUserId: null,
        };
    }
    const owner = await mailUserById(logUserId, now);
    if (!owner) return { ...none, logUserId };
    if (address.kind === "secret") {
        return {
            recipient,
            address,
            target: { kind: "secret", address: recipient, owner },
            logUserId,
        };
    }
    return {
        recipient,
        address,
        target: {
            kind: "personal",
            addressKind: address.kind === "mailbox" ? "mailbox" : "folder",
            address: recipient,
            owner,
        },
        logUserId,
    };
}

function verdictFor(
    resolved: Resolved,
    facts: MessageFacts,
    senderUser: MailUser | null,
): RecipientVerdict {
    if (resolved.address?.status === "paused") {
        return { accept: false, reason: "address_inactive" };
    }
    return evaluateRecipient({
        message: facts,
        target: resolved.target,
        senderUser,
        options: { maxSignatureAgeHours: env.MAIL_MAX_SIGNATURE_AGE_HOURS },
    });
}

async function senderFor(
    facts: MessageFacts,
    now: Date,
): Promise<MailUser | null> {
    const [from] = facts.fromAddresses;
    if (facts.fromAddresses.length !== 1 || !from) return null;
    return mailUserByEmail(from, now);
}

async function logRefusal(input: {
    resolved: Resolved;
    reason: RefusalReason;
    senderUser: MailUser | null;
    facts: MessageFacts;
    at: Date;
}): Promise<void> {
    // An Organization address belongs to an account nobody signs in to:
    // its refusals go to the sender, when they are a user.
    const userId = input.resolved.logUserId ?? input.senderUser?.userId ?? null;
    if (!userId) return;
    const domain = domainOf(input.facts.fromAddresses[0]);
    await db.insert(mailDeliveryLog).values({
        userId,
        at: input.at,
        addressId: input.resolved.address?.id ?? null,
        senderDomain: domain ? encryptText(domain) : null,
        outcome: "refused",
        reason: input.reason,
    });
}

/**
 * Which recipients would pass, by the receiver's metadata. Refusals are
 * logged only when nothing passes: otherwise the ingest that follows
 * judges, and logs, every recipient again.
 */
export async function precheckMail(
    input: PrecheckInput,
): Promise<{ accepted: string[] }> {
    if (!isMailEnabled()) return { accepted: [] };
    const now = input.facts.receivedAt;
    const recipients = ourRecipients(input.recipients);
    const senderUser = await senderFor(input.facts, now);
    const judged = await Promise.all(
        recipients.map(async (recipient) => {
            const resolved = await resolveRecipient(recipient, now);
            return {
                resolved,
                verdict: verdictFor(resolved, input.facts, senderUser),
            };
        }),
    );
    const accepted = judged
        .filter((entry) => entry.verdict.accept)
        .map((entry) => entry.resolved.recipient);
    if (accepted.length === 0) {
        for (const { resolved, verdict } of judged) {
            if (verdict.accept) continue;
            await logRefusal({
                resolved,
                reason: verdict.reason,
                senderUser,
                facts: input.facts,
                at: now,
            });
        }
    }
    return { accepted };
}

/** How many messages an owner received since the UTC day began. */
async function receivedToday(ownerUserId: string, now: Date): Promise<number> {
    const dayStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const [row] = await db
        .select({ n: count() })
        .from(mailMessages)
        .where(
            and(
                eq(mailMessages.userId, ownerUserId),
                gte(mailMessages.receivedAt, dayStart),
            ),
        );
    return row?.n ?? 0;
}

/** Verifies, parses, judges and stores one message for every recipient. */
export async function ingestMail(input: IngestInput): Promise<IngestResult> {
    const outcomes: IngestResult["outcomes"] = input.recipients.map(
        (recipient) => ({
            recipient: recipient.trim().toLowerCase(),
            outcome: "not_ours" as RecipientOutcome,
        }),
    );
    if (!isMailEnabled()) return { outcomes, overQuota: false };
    const now = input.receivedAt;
    const facts = await authenticateMessage(input.raw, {
        resolver: input.resolver,
        now,
    });
    const senderUser = await senderFor(facts, now);

    const byOwner = new Map<string, OwnerDelivery>();
    const outcomeOf = new Map<string, RecipientOutcome>();
    for (const recipient of ourRecipients(input.recipients)) {
        const resolved = await resolveRecipient(recipient, now);
        const verdict = verdictFor(resolved, facts, senderUser);
        if (!verdict.accept) {
            outcomeOf.set(recipient, "refused");
            await logRefusal({
                resolved,
                reason: verdict.reason,
                senderUser,
                facts,
                at: now,
            });
            continue;
        }
        const delivery = byOwner.get(verdict.ownerUserId) ?? {
            ownerUserId: verdict.ownerUserId,
            senderVerified: verdict.senderVerified,
            folderIds: [],
            pendingShareFolderIds: [],
            addresses: [],
            recipients: [],
        };
        delivery.senderVerified &&= verdict.senderVerified;
        const target = resolved.target;
        const folderId = resolved.address?.folderId ?? null;
        if (target?.kind === "organization" && folderId) {
            delivery.pendingShareFolderIds.push(folderId);
        } else if (folderId) {
            delivery.folderIds.push(folderId);
        } else if (resolved.address?.kind === "secret") {
            const base = resolved.address.baseAddressId
                ? await baseFolderOf(resolved.address.baseAddressId)
                : null;
            if (base) delivery.folderIds.push(base);
        }
        if (resolved.address) delivery.addresses.push(resolved.address.id);
        delivery.recipients.push(recipient);
        byOwner.set(verdict.ownerUserId, delivery);
    }

    let overQuota = false;
    if (byOwner.size > 0) {
        const parsed = await parseMessage(input.raw);
        for (const delivery of byOwner.values()) {
            if (
                (await receivedToday(delivery.ownerUserId, now)) >=
                env.MAIL_DAILY_LIMIT
            ) {
                overQuota = true;
                for (const recipient of delivery.recipients) {
                    outcomeOf.set(recipient, "quota");
                }
                continue;
            }
            const stored = await storeMailForOwner({
                delivery,
                raw: input.raw,
                parsed,
                facts,
                spf: input.spf,
                receivedAt: now,
            });
            for (const recipient of delivery.recipients) {
                outcomeOf.set(
                    recipient,
                    stored.duplicate ? "duplicate" : "accepted",
                );
            }
        }
    }
    for (const entry of outcomes) {
        entry.outcome = outcomeOf.get(entry.recipient) ?? entry.outcome;
    }
    return { outcomes, overQuota };
}

/** The folder a secret address's base address files into, if any. */
async function baseFolderOf(baseAddressId: string): Promise<string | null> {
    const [row] = await db
        .select({ folderId: mailAddresses.folderId })
        .from(mailAddresses)
        .where(eq(mailAddresses.id, baseAddressId))
        .limit(1);
    return row?.folderId ?? null;
}
