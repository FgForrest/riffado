import type { Account } from "better-auth";
import { APIError } from "better-auth/api";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { accounts, users } from "@/db/schema";
import { ensureMailbox } from "@/lib/mail/addresses";
import { recordSsoUserInAlmanac } from "@/lib/sso/almanac";
import { SSO_ORG_ACCOUNT_ERROR, SSO_PROVIDER_ID } from "@/lib/sso/constants";

async function refuseOrgAccount(userId: string): Promise<void> {
    const [row] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    if (row?.role === "org") {
        throw APIError.from("FORBIDDEN", {
            code: SSO_ORG_ACCOUNT_ERROR,
            message: "The organization account cannot sign in",
        });
    }
}

/**
 * Profile mapping for the identity provider. The email follows the provider
 * on every login, except onto an address another Riffado account holds:
 * that account is someone else's, so the user keeps their current address.
 */
export async function mapSsoProfile(
    profile: Record<string, unknown>,
): Promise<{ email?: string }> {
    const subject = profile.sub ?? profile.id;
    const email =
        typeof profile.email === "string" ? profile.email.toLowerCase() : null;
    if (typeof subject !== "string" || !email) return {};

    const [linked] = await db
        .select({ userId: users.id, email: users.email })
        .from(accounts)
        .innerJoin(users, eq(users.id, accounts.userId))
        .where(
            and(
                eq(accounts.providerId, SSO_PROVIDER_ID),
                eq(accounts.accountId, subject),
            ),
        )
        .limit(1);
    if (!linked || linked.email === email) return {};

    const [holder] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), ne(users.id, linked.userId)))
        .limit(1);
    if (!holder) return {};
    console.warn(
        "[sso] identity provider email belongs to another account; keeping the current one",
    );
    return { email: linked.email };
}

/**
 * Before an identity is attached to a user: never to the organization
 * account, and without the provider's tokens. Riffado signs in with the
 * provider and never calls it afterwards, so its tokens are not kept.
 */
export async function prepareSsoAccount(account: {
    userId: string;
    providerId: string;
}): Promise<{ data: Partial<Account> } | undefined> {
    if (account.providerId !== SSO_PROVIDER_ID) return undefined;
    await refuseOrgAccount(account.userId);
    return {
        data: {
            accessToken: null,
            refreshToken: null,
            idToken: null,
            accessTokenExpiresAt: null,
            refreshTokenExpiresAt: null,
        },
    };
}

/** Before a session starts: the organization account has no interactive login. */
export async function guardSsoSession(session: {
    userId: string;
}): Promise<void> {
    await refuseOrgAccount(session.userId);
}

/**
 * After a session started: the person goes into the Almanac. A failure is
 * logged and never costs the user their login.
 */
export async function afterSsoSession(session: {
    userId: string;
}): Promise<void> {
    try {
        const [user] = await db
            .select({ id: users.id, name: users.name, email: users.email })
            .from(users)
            .where(eq(users.id, session.userId))
            .limit(1);
        if (!user) return;
        await recordSsoUserInAlmanac(user);
    } catch (error) {
        console.error("[sso] could not record the user in the Almanac:", error);
    }
    try {
        // Signing in keeps the user's addresses receiving, and gives them
        // their mailbox the first time once mail is on.
        await db
            .update(users)
            .set({ lastSsoLoginAt: new Date() })
            .where(eq(users.id, session.userId));
        await ensureMailbox(session.userId);
    } catch (error) {
        console.error("[mail] could not set up the user's mailbox:", error);
    }
}
