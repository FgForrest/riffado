import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, userSettings, users } from "@/db/schema";
import { env } from "@/lib/env";
import {
    ensureOrgRootFolder,
    retireLegacyPublicRoots,
} from "@/lib/folders/folders";
import { isOrgScopeEnabled } from "@/lib/org/config";

const DEFAULT_ORG_NAME = "Organization";

/**
 * Create or update the organization account from the environment.
 *
 * Bound to the `org` role rather than to the email, so changing
 * ORG_ACCOUNT_EMAIL renames the one account instead of minting a second one.
 * Never converts an existing regular account: an email collision is a
 * configuration error, reported and left alone.
 *
 * Runs under an advisory lock because every app process calls it at start.
 */
export async function ensureOrgAccount(): Promise<string | null> {
    if (!isOrgScopeEnabled()) return null;
    const email = env.ORG_ACCOUNT_EMAIL;
    const password = env.ORG_ACCOUNT_PASSWORD;
    if (!email || !password) return null;
    const name = env.ORG_ACCOUNT_NAME ?? DEFAULT_ORG_NAME;

    return db.transaction(async (tx) => {
        await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('riffado:org-account'))`,
        );

        const [existing] = await tx
            .select({ id: users.id, email: users.email, name: users.name })
            .from(users)
            .where(eq(users.role, "org"))
            .limit(1);
        const [holder] = await tx
            .select({ id: users.id, role: users.role })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
        if (holder && holder.id !== existing?.id) {
            throw new Error(
                `ORG_ACCOUNT_EMAIL ${email} already belongs to a regular account; choose another address`,
            );
        }

        let orgUserId: string;
        if (existing) {
            orgUserId = existing.id;
            if (existing.email !== email || existing.name !== name) {
                await tx
                    .update(users)
                    .set({ email, name, updatedAt: new Date() })
                    .where(eq(users.id, orgUserId));
            }
        } else {
            const [created] = await tx
                .insert(users)
                .values({ email, name, emailVerified: true, role: "org" })
                .returning({ id: users.id });
            if (!created)
                throw new Error("Organization account was not created");
            orgUserId = created.id;
        }

        const [credential] = await tx
            .select({ id: accounts.id, password: accounts.password })
            .from(accounts)
            .where(
                and(
                    eq(accounts.userId, orgUserId),
                    eq(accounts.providerId, "credential"),
                ),
            )
            .limit(1);
        if (!credential) {
            await tx.insert(accounts).values({
                userId: orgUserId,
                accountId: orgUserId,
                providerId: "credential",
                password: await hashPassword(password),
            });
        } else if (
            !credential.password ||
            !(await verifyPassword({ hash: credential.password, password }))
        ) {
            await tx
                .update(accounts)
                .set({
                    password: await hashPassword(password),
                    updatedAt: new Date(),
                })
                .where(eq(accounts.id, credential.id));
        }

        await tx
            .insert(userSettings)
            .values({ userId: orgUserId, onboardingCompleted: true })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: { onboardingCompleted: true },
            });
        await ensureOrgRootFolder(tx, orgUserId);
        return orgUserId;
    });
}

/** Retire per-user Public roots on self-host. Idempotent; safe in every process. */
export async function retireLegacyPublicFolders(): Promise<number> {
    if (env.IS_HOSTED) return 0;
    return db.transaction(async (tx) => {
        await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('riffado:legacy-public'))`,
        );
        return retireLegacyPublicRoots(tx);
    });
}

/** Startup hook: legacy folder migration, then the organization account. */
export async function startOrgScope(): Promise<void> {
    try {
        const retired = await retireLegacyPublicFolders();
        if (retired > 0) {
            console.log(`[org] retired ${retired} per-user Public folder(s)`);
        }
    } catch (error) {
        console.error("[org] could not retire per-user Public folders:", error);
    }
    try {
        const orgUserId = await ensureOrgAccount();
        if (orgUserId) console.log("[org] organization account ready");
    } catch (error) {
        console.error("[org] organization account is unavailable:", error);
    }
}
