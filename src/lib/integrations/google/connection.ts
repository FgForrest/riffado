import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { oauthConnections } from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { getGoogleIntegrationConfig } from "./config";
import { GoogleApiError, GoogleConnectionUnavailableError } from "./errors";
import {
    type IdTokenClaims,
    refreshAccessToken,
    revokeToken,
    type TokenResponse,
} from "./oauth";

export interface GoogleConnectionStatus {
    subject: string;
    email: string;
    hostedDomain: string | null;
    status: "active" | "needs_reconnect";
    scopes: string[];
}

interface CachedAccessToken {
    accessToken: string;
    subject: string;
    expiresAt: number;
}

const accessTokens = new Map<string, CachedAccessToken>();
/** Refresh this long before Google's expiry, so a call never races it. */
const EXPIRY_MARGIN_MS = 60_000;

async function connectionRow(userId: string) {
    const [row] = await db
        .select()
        .from(oauthConnections)
        .where(
            and(
                eq(oauthConnections.userId, userId),
                eq(oauthConnections.provider, "google"),
            ),
        )
        .limit(1);
    return row ?? null;
}

export async function getGoogleConnectionStatus(
    userId: string,
): Promise<GoogleConnectionStatus | null> {
    const row = await connectionRow(userId);
    if (!row) return null;
    return {
        subject: row.subject,
        email: row.email,
        hostedDomain: row.hostedDomain,
        status: row.status,
        scopes: row.scopes.split(" ").filter(Boolean),
    };
}

/**
 * Stores the account a user just connected. Google omits the refresh token
 * when re-consenting to scopes already granted; the stored one is kept then,
 * but only for the same account.
 */
export async function saveGoogleConnection(
    userId: string,
    claims: IdTokenClaims,
    tokens: TokenResponse,
): Promise<void> {
    const existing = await connectionRow(userId);
    const refreshToken =
        tokens.refreshToken ??
        (existing && existing.subject === claims.subject
            ? decryptText(existing.refreshToken)
            : null);
    if (!refreshToken) {
        throw new Error("Google returned no refresh token");
    }
    const values = {
        subject: claims.subject,
        email: claims.email,
        hostedDomain: claims.hostedDomain,
        refreshToken: encryptText(refreshToken),
        scopes: tokens.scopes.join(" "),
        status: "active" as const,
        lastError: null,
        updatedAt: new Date(),
    };
    await db
        .insert(oauthConnections)
        .values({ userId, provider: "google", ...values })
        .onConflictDoUpdate({
            target: [oauthConnections.userId, oauthConnections.provider],
            set: values,
        });
    accessTokens.set(userId, {
        accessToken: tokens.accessToken,
        subject: claims.subject,
        expiresAt: Date.now() + tokens.expiresInSeconds * 1000,
    });
    if (existing && existing.subject !== claims.subject) {
        await revokeToken(decryptText(existing.refreshToken)).catch((error) => {
            console.error(
                "[google] could not revoke the replaced account:",
                error,
            );
        });
    }
}

export async function markGoogleNeedsReconnect(
    userId: string,
    message: string,
): Promise<void> {
    accessTokens.delete(userId);
    await db
        .update(oauthConnections)
        .set({
            status: "needs_reconnect",
            lastError: message.slice(0, 2000),
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(oauthConnections.userId, userId),
                eq(oauthConnections.provider, "google"),
            ),
        );
}

/** Drops the cached access token, so the next call refreshes it. */
export function invalidateGoogleAccessToken(userId: string): void {
    accessTokens.delete(userId);
}

/**
 * A current access token for the user's Google account, refreshed when
 * due. With `expectedSubject`, only for that account: an export set up
 * through one account never writes through another.
 */
export async function getGoogleAccessToken(
    userId: string,
    options: { expectedSubject?: string; fetchImpl?: typeof fetch } = {},
): Promise<string> {
    const config = getGoogleIntegrationConfig();
    if (!config) throw new GoogleConnectionUnavailableError("not_configured");
    const row = await connectionRow(userId);
    if (!row) throw new GoogleConnectionUnavailableError("not_connected");
    if (row.status === "needs_reconnect") {
        throw new GoogleConnectionUnavailableError("needs_reconnect");
    }
    if (options.expectedSubject && row.subject !== options.expectedSubject) {
        throw new GoogleConnectionUnavailableError("account_mismatch");
    }
    const cached = accessTokens.get(userId);
    if (
        cached &&
        cached.subject === row.subject &&
        cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()
    ) {
        return cached.accessToken;
    }
    let tokens: TokenResponse;
    try {
        tokens = await refreshAccessToken(
            config,
            decryptText(row.refreshToken),
            options.fetchImpl,
        );
    } catch (error) {
        if (
            error instanceof GoogleApiError &&
            (error.reason === "invalid_grant" ||
                error.reason === "unauthorized_client")
        ) {
            await markGoogleNeedsReconnect(userId, error.message);
            throw new GoogleConnectionUnavailableError("needs_reconnect");
        }
        throw error;
    }
    accessTokens.set(userId, {
        accessToken: tokens.accessToken,
        subject: row.subject,
        expiresAt: Date.now() + tokens.expiresInSeconds * 1000,
    });
    if (tokens.refreshToken) {
        await db
            .update(oauthConnections)
            .set({
                refreshToken: encryptText(tokens.refreshToken),
                updatedAt: new Date(),
            })
            .where(eq(oauthConnections.id, row.id));
    }
    return tokens.accessToken;
}

/**
 * A token source for a long job: checks the connection on its first call
 * and whenever the cached token is due, not on every request.
 */
export function googleAccessTokenSource(
    userId: string,
    expectedSubject: string,
): () => Promise<string> {
    return async () => {
        const cached = accessTokens.get(userId);
        if (
            cached &&
            cached.subject === expectedSubject &&
            cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()
        ) {
            return cached.accessToken;
        }
        return getGoogleAccessToken(userId, { expectedSubject });
    };
}

/** Revokes the grant at Google (best effort) and forgets the account. */
export async function disconnectGoogle(userId: string): Promise<boolean> {
    const row = await connectionRow(userId);
    accessTokens.delete(userId);
    if (!row) return false;
    await revokeToken(decryptText(row.refreshToken)).catch((error) => {
        console.error("[google] could not revoke on disconnect:", error);
    });
    await db.delete(oauthConnections).where(eq(oauthConnections.id, row.id));
    return true;
}

export function __resetGoogleAccessTokensForTests(): void {
    accessTokens.clear();
}
