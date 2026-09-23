import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";

/**
 * Whether this deployment shows the Organization scope at all: self-host in
 * `shared` mode. `local` keeps every account strictly private.
 */
export function isOrgScopeVisible(): boolean {
    return !env.IS_HOSTED && env.SELF_HOST_MODE === "shared";
}

/**
 * Whether the Organization scope accepts changes: visible, and configured
 * with its account. With the account's env vars removed, what was shared
 * stays readable and nothing is deleted, but nothing changes either.
 */
export function isOrgScopeEnabled(): boolean {
    return (
        isOrgScopeVisible() &&
        Boolean(env.ORG_ACCOUNT_EMAIL && env.ORG_ACCOUNT_PASSWORD)
    );
}

/**
 * Id of the organization account, or null when the scope is not visible or
 * no account was ever created. Resolved by role, so it outlives its env vars.
 */
export async function getOrgUserId(): Promise<string | null> {
    if (!isOrgScopeVisible()) return null;
    const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "org"))
        .limit(1);
    return row?.id ?? null;
}

/**
 * Id of the organization account whatever the deployment mode.
 *
 * For protections that must outlive a mode switch: audio a recording's
 * colleagues relied on stays protected even if the instance is switched to
 * `local` later.
 */
export async function findOrgAccountId(): Promise<string | null> {
    if (env.IS_HOSTED) return null;
    const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "org"))
        .limit(1);
    return row?.id ?? null;
}

/** Reject a change to the Organization scope while it is read-only. */
export function assertOrgScopeWritable(): void {
    if (!isOrgScopeEnabled()) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "The Organization is read-only on this instance",
            403,
        );
    }
}

/**
 * Whether `userId` is the organization account.
 *
 * Checked by role, not by whether the scope is enabled: an org account left
 * behind by removed env vars must still never gain a private scope.
 */
export async function isOrgAccount(userId: string): Promise<boolean> {
    const [row] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    return row?.role === "org";
}

/** Reject actions that would give the organization account recordings of its own. */
export async function assertNotOrgAccount(userId: string): Promise<void> {
    if (await isOrgAccount(userId)) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "The organization account cannot own recordings",
            403,
        );
    }
}
