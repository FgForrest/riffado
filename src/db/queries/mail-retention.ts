import {
    and,
    eq,
    exists,
    isNotNull,
    isNull,
    lt,
    not,
    or,
    type SQL,
    sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
    type RetentionGovernor,
    retentionCutoff,
    validRetentionDays,
} from "@/db/queries/retention";
import {
    aiEnhancements,
    chatterItems,
    knowledgeFactEvidence,
    learnRuns,
    mailContents,
    mailLearnedParts,
    mailMessages,
    recordingTasks,
    userSettings,
    users,
} from "@/db/schema";
import {
    knowledgeOnRecordingInTx,
    pruneUnsupportedFactsInTx,
} from "@/lib/knowledge/fact-evidence";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { isRecordingShared, sharedItemCondition } from "@/lib/sharing/shared";
import { dropTasksWithoutSummaryInTx } from "@/lib/tasks/store";

/** One part of a mail a retention policy can remove. */
export type MailRetentionKind = "raw" | "content" | "summary";

/**
 * A mail retention policy, in days from when a mail arrived (never its
 * `Date` header, which its sender writes). The organization account's
 * (`isOrg`) governs every part of a shared mail, and its owner's none.
 */
export interface MailRetentionPolicy {
    userId: string;
    /** The message as it arrived, its attachments with it. */
    rawDays: number | null;
    /** Its text: the parts read, summarized and learned from. */
    contentDays: number | null;
    summaryDays: number | null;
    isOrg?: boolean;
}

export interface MailReapCandidate {
    id: string;
    /** The mail's owner, whose rows and stored message are reaped. */
    userId: string;
    receivedAt: Date;
    rawStoragePath: string | null;
    contentReapedAt: Date | null;
    summaryReapedAt: Date | null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Every account with at least one mail retention period, the Organization's first. */
export async function listArmedMailRetentionPolicies(
    limit: number,
): Promise<MailRetentionPolicy[]> {
    const rows = await db
        .select({
            userId: userSettings.userId,
            rawDays: userSettings.retentionMailRawDays,
            contentDays: userSettings.retentionMailContentDays,
            summaryDays: userSettings.retentionMailSummaryDays,
            role: users.role,
        })
        .from(userSettings)
        .innerJoin(users, eq(users.id, userSettings.userId))
        .where(
            or(
                sql`${userSettings.retentionMailRawDays} > 0`,
                sql`${userSettings.retentionMailContentDays} > 0`,
                sql`${userSettings.retentionMailSummaryDays} > 0`,
            ),
        )
        .orderBy(sql`${users.role} = 'org' desc`, sql`random()`)
        .limit(limit);
    return rows.flatMap((row) => {
        const policy = mailPolicyOf(row);
        return policy ? [{ ...policy, isOrg: row.role === "org" }] : [];
    });
}

/** A settings row's mail policy, or null when it removes nothing. */
export function mailPolicyOf(row: {
    userId: string;
    rawDays: number | null;
    contentDays: number | null;
    summaryDays: number | null;
}): MailRetentionPolicy | null {
    const policy = {
        userId: row.userId,
        rawDays: validRetentionDays(row.rawDays),
        contentDays: validRetentionDays(row.contentDays),
        summaryDays: validRetentionDays(row.summaryDays),
    };
    return policy.rawDays !== null ||
        policy.contentDays !== null ||
        policy.summaryDays !== null
        ? policy
        : null;
}

/**
 * The mail older than its parts' periods that still holds one of them,
 * shared by the sweep and the Settings preview. Null when the policy
 * removes nothing.
 */
function mailReapWhere(
    policy: MailRetentionPolicy,
    now: number,
    orgUserId: string | null,
): SQL | null {
    const due = (days: number) =>
        lt(mailMessages.receivedAt, retentionCutoff(days, now));
    const parts: SQL[] = [];
    if (policy.rawDays !== null) {
        parts.push(
            and(
                due(policy.rawDays),
                isNotNull(mailMessages.rawStoragePath),
            ) as SQL,
        );
    }
    if (policy.contentDays !== null) {
        parts.push(
            and(
                due(policy.contentDays),
                isNull(chatterItems.contentReapedAt),
                exists(
                    db
                        .select({ id: mailContents.id })
                        .from(mailContents)
                        .where(
                            and(
                                eq(mailContents.itemId, chatterItems.id),
                                eq(mailContents.userId, chatterItems.userId),
                            ),
                        ),
                ),
            ) as SQL,
        );
    }
    if (policy.summaryDays !== null) {
        parts.push(
            and(
                due(policy.summaryDays),
                isNull(chatterItems.summaryReapedAt),
                or(
                    exists(
                        db
                            .select({ id: aiEnhancements.id })
                            .from(aiEnhancements)
                            .where(
                                and(
                                    eq(aiEnhancements.itemId, chatterItems.id),
                                    eq(
                                        aiEnhancements.userId,
                                        chatterItems.userId,
                                    ),
                                ),
                            ),
                    ),
                    exists(
                        db
                            .select({ id: recordingTasks.id })
                            .from(recordingTasks)
                            .where(eq(recordingTasks.itemId, chatterItems.id)),
                    ),
                ),
            ) as SQL,
        );
    }
    if (parts.length === 0) return null;
    // A shared mail is the Organization's policy's; the owner's yields it.
    const governed = policy.isOrg
        ? sharedItemCondition(policy.userId, chatterItems.id)
        : and(
              eq(chatterItems.userId, policy.userId),
              orgUserId
                  ? not(sharedItemCondition(orgUserId, chatterItems.id))
                  : undefined,
          );
    return and(governed, isNull(chatterItems.deletedAt), or(...parts)) as SQL;
}

function fromMail() {
    return db
        .select({
            id: chatterItems.id,
            userId: chatterItems.userId,
            receivedAt: mailMessages.receivedAt,
            rawStoragePath: mailMessages.rawStoragePath,
            contentReapedAt: chatterItems.contentReapedAt,
            summaryReapedAt: chatterItems.summaryReapedAt,
        })
        .from(mailMessages)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, mailMessages.id),
                eq(chatterItems.userId, mailMessages.userId),
            ),
        );
}

/** The mail the policy would reap now, oldest first, at most `limit`. */
export async function listMailReapCandidates(
    policy: MailRetentionPolicy,
    now: Date,
    limit: number,
    orgUserId: string | null,
): Promise<MailReapCandidate[]> {
    const where = mailReapWhere(policy, now.getTime(), orgUserId);
    if (where === null) return [];
    return fromMail()
        .where(where)
        .orderBy(mailMessages.receivedAt)
        .limit(limit);
}

/** How much mail the policy would reap now, for the Settings preview. */
export async function countMailReapCandidates(
    policy: MailRetentionPolicy,
    now: number,
    orgUserId: string | null,
): Promise<number> {
    const where = mailReapWhere(policy, now, orgUserId);
    if (where === null) return 0;
    const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(mailMessages)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, mailMessages.id),
                eq(chatterItems.userId, mailMessages.userId),
            ),
        )
        .where(where);
    return row?.count ?? 0;
}

/**
 * Lock the mail, as sharing and withdrawing do, and say whether the
 * governor still governs it.
 */
async function lockGovernedMailInTx(
    tx: Tx,
    itemId: string,
    ownerUserId: string,
    governor: RetentionGovernor,
): Promise<boolean> {
    const [item] = await tx
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, ownerUserId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .for("update");
    if (!item) return false;
    if (!governor.orgUserId) return !governor.isOrg;
    return (
        (await isRecordingShared(itemId, governor.orgUserId, tx)) ===
        governor.isOrg
    );
}

/**
 * Delete a mail's stored message with `removeFile` and mark it reaped, if
 * the governor still governs the mail. Returns whether it went.
 */
export async function reapRawMailMessage(
    itemId: string,
    ownerUserId: string,
    governor: RetentionGovernor,
    at: Date,
    removeFile: (key: string) => Promise<void>,
): Promise<boolean> {
    return db.transaction(async (tx) => {
        if (!(await lockGovernedMailInTx(tx, itemId, ownerUserId, governor))) {
            return false;
        }
        const [message] = await tx
            .select({ path: mailMessages.rawStoragePath })
            .from(mailMessages)
            .where(
                and(
                    eq(mailMessages.id, itemId),
                    eq(mailMessages.userId, ownerUserId),
                ),
            );
        if (!message?.path) return false;
        await removeFile(message.path);
        await tx
            .update(mailMessages)
            .set({ rawStoragePath: null, rawReapedAt: at, updatedAt: at })
            .where(
                and(
                    eq(mailMessages.id, itemId),
                    eq(mailMessages.userId, ownerUserId),
                ),
            );
        return true;
    });
}

/**
 * Delete a mail's text and mark it reaped, if the governor still governs
 * the mail, with what was read from it: the evidence in it (D5: the facts
 * only it said go too) and its Learn runs. Participants stay: the mail
 * still shows who wrote it to whom. Returns whether the text went.
 */
export async function deleteMailContent(
    itemId: string,
    ownerUserId: string,
    governor: RetentionGovernor,
    at: Date,
): Promise<boolean> {
    return db.transaction(async (tx) => {
        if (!(await lockGovernedMailInTx(tx, itemId, ownerUserId, governor))) {
            return false;
        }
        const knowledge = await knowledgeOnRecordingInTx(tx, itemId);
        const removed = await tx
            .delete(mailContents)
            .where(
                and(
                    eq(mailContents.itemId, itemId),
                    eq(mailContents.userId, ownerUserId),
                ),
            )
            .returning({ id: mailContents.id });
        if (removed.length === 0) return false;
        // Nothing cascades from the text: its anchors point at the item.
        await tx
            .delete(knowledgeFactEvidence)
            .where(
                and(
                    eq(knowledgeFactEvidence.itemId, itemId),
                    isNotNull(knowledgeFactEvidence.segmentIndex),
                ),
            );
        await tx.delete(learnRuns).where(eq(learnRuns.itemId, itemId));
        // Its signatures and disclaimers were read here: read them again
        // in the next mail that has them.
        await tx
            .delete(mailLearnedParts)
            .where(eq(mailLearnedParts.itemId, itemId));
        await pruneUnsupportedFactsInTx(tx, knowledge.factIds);
        await tx
            .update(chatterItems)
            .set({ contentReapedAt: at, updatedAt: at })
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, ownerUserId),
                ),
            );
        await bumpScopeInTx(tx, knowledge.scopes);
        return true;
    });
}

/**
 * Delete a mail's summaries, and with them its tasks, and mark them
 * reaped, if the governor still governs the mail. Returns how many went.
 */
export async function deleteMailSummaries(
    itemId: string,
    ownerUserId: string,
    governor: RetentionGovernor,
    at: Date,
): Promise<number> {
    return db.transaction(async (tx) => {
        if (!(await lockGovernedMailInTx(tx, itemId, ownerUserId, governor))) {
            return 0;
        }
        const rows = await tx
            .delete(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, itemId),
                    eq(aiEnhancements.userId, ownerUserId),
                ),
            )
            .returning({ id: aiEnhancements.id });
        await dropTasksWithoutSummaryInTx(tx, {
            recordingId: itemId,
            ownerUserId,
        });
        // Marked only when a summary went: a mail that never had one may
        // still get its first.
        if (rows.length > 0) {
            await tx
                .update(chatterItems)
                .set({ summaryReapedAt: at, updatedAt: at })
                .where(
                    and(
                        eq(chatterItems.id, itemId),
                        eq(chatterItems.userId, ownerUserId),
                    ),
                );
        }
        return rows.length;
    });
}
