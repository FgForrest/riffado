import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems } from "@/db/schema";
import { getOrgUserId } from "@/lib/org/config";
import { isRecordingShared } from "@/lib/sharing/shared";

/**
 * - `owner`: the mail's owner.
 * - `member`: any other regular user, on a mail shared into the Organization.
 * - `curator`: the organization account, on a shared mail.
 */
export interface MailAccess {
    itemId: string;
    ownerUserId: string;
    role: "owner" | "member" | "curator";
}

/**
 * Who `userId` is to the mail `itemId`, or null when they may not see it:
 * callers answer 404 either way, so nobody learns that it exists.
 */
export async function resolveMailAccess(
    userId: string,
    itemId: string,
): Promise<MailAccess | null> {
    const [item] = await db
        .select({ userId: chatterItems.userId })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.kind, "mail"),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item) return null;
    if (item.userId === userId) {
        return { itemId, ownerUserId: item.userId, role: "owner" };
    }
    const orgUserId = await getOrgUserId();
    if (!orgUserId || !(await isRecordingShared(itemId, orgUserId))) {
        return null;
    }
    return {
        itemId,
        ownerUserId: item.userId,
        role: userId === orgUserId ? "curator" : "member",
    };
}
