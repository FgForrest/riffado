import { createHash, randomBytes } from "node:crypto";
import type { GoogleIntegrationConfig } from "./config";
import { GoogleApiError } from "./errors";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

type Fetch = typeof fetch;

export interface PkcePair {
    verifier: string;
    challenge: string;
}

export function createPkcePair(): PkcePair {
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

export function createOAuthState(): string {
    return randomBytes(24).toString("base64url");
}

export function buildAuthorizationUrl(input: {
    config: GoogleIntegrationConfig;
    scopes: string[];
    state: string;
    codeChallenge: string;
    loginHint?: string;
}): string {
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set("client_id", input.config.clientId);
    url.searchParams.set("redirect_uri", input.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", input.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // Offline + consent: the only combination that always returns a
    // refresh token, which the export needs to run without the user.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    if (input.config.workspaceDomains.length === 1) {
        url.searchParams.set("hd", input.config.workspaceDomains[0] ?? "");
    }
    if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
    return url.toString();
}

export interface TokenResponse {
    accessToken: string;
    expiresInSeconds: number;
    refreshToken: string | null;
    scopes: string[];
    idToken: string | null;
}

async function tokenError(response: Response): Promise<GoogleApiError> {
    const body = (await response.json().catch(() => null)) as {
        error?: string;
        error_description?: string;
    } | null;
    return new GoogleApiError(
        response.status,
        body?.error ?? null,
        `Google token endpoint: ${body?.error_description ?? body?.error ?? response.statusText}`,
    );
}

async function postToken(
    body: Record<string, string>,
    fetchImpl: Fetch,
): Promise<TokenResponse> {
    const response = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
    });
    if (!response.ok) throw await tokenError(response);
    const json = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
        scope?: string;
        id_token?: string;
    };
    if (!json.access_token) {
        throw new GoogleApiError(
            502,
            null,
            "Google token endpoint returned no access token",
        );
    }
    return {
        accessToken: json.access_token,
        expiresInSeconds: json.expires_in ?? 3600,
        refreshToken: json.refresh_token ?? null,
        scopes: (json.scope ?? "").split(" ").filter(Boolean),
        idToken: json.id_token ?? null,
    };
}

export function exchangeAuthorizationCode(
    input: {
        config: GoogleIntegrationConfig;
        code: string;
        codeVerifier: string;
    },
    fetchImpl: Fetch = fetch,
): Promise<TokenResponse> {
    return postToken(
        {
            grant_type: "authorization_code",
            code: input.code,
            code_verifier: input.codeVerifier,
            client_id: input.config.clientId,
            client_secret: input.config.clientSecret,
            redirect_uri: input.config.redirectUri,
        },
        fetchImpl,
    );
}

/** Throws `GoogleApiError` with reason `invalid_grant` once access is revoked. */
export function refreshAccessToken(
    config: GoogleIntegrationConfig,
    refreshToken: string,
    fetchImpl: Fetch = fetch,
): Promise<TokenResponse> {
    return postToken(
        {
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: config.clientId,
            client_secret: config.clientSecret,
        },
        fetchImpl,
    );
}

/** Revokes the grant behind `token`. A token already invalid counts as done. */
export async function revokeToken(
    token: string,
    fetchImpl: Fetch = fetch,
): Promise<void> {
    const response = await fetchImpl(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
    });
    if (response.ok || response.status === 400) return;
    throw await tokenError(response);
}

export interface IdTokenClaims {
    subject: string;
    email: string;
    emailVerified: boolean;
    hostedDomain: string | null;
}

/**
 * Reads the claims of an ID token received straight from Google's token
 * endpoint over TLS; per OpenID Connect such a token needs no signature
 * check. Never use this on a token that came from anywhere else.
 */
export function readIdTokenClaims(idToken: string): IdTokenClaims {
    const payload = idToken.split(".")[1];
    if (!payload) throw new Error("Malformed Google ID token");
    const claims = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
        sub?: unknown;
        email?: unknown;
        email_verified?: unknown;
        hd?: unknown;
    };
    if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
        throw new Error("Google ID token lacks subject or email");
    }
    return {
        subject: claims.sub,
        email: claims.email.toLowerCase(),
        emailVerified: claims.email_verified === true,
        hostedDomain:
            typeof claims.hd === "string" ? claims.hd.toLowerCase() : null,
    };
}
