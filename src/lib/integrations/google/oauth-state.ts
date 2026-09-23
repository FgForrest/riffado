import { decryptText, encryptText } from "@/lib/encryption/fields";

export const GOOGLE_OAUTH_COOKIE = "riffado_google_oauth";
export const GOOGLE_OAUTH_COOKIE_PATH = "/api/integrations/google";
export const GOOGLE_OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** What the connect route hands the callback, sealed in a cookie. */
export interface GoogleOAuthState {
    state: string;
    verifier: string;
    userId: string;
    returnTo: string;
    expiresAt: number;
}

export function sealGoogleOAuthState(payload: GoogleOAuthState): string {
    return encryptText(JSON.stringify(payload));
}

/**
 * The sealed state, or null when missing, expired, or not sealed by this
 * instance. `decryptText` passes plaintext through, so the prefix check is
 * what stops a cookie the browser made up from being trusted.
 */
export function openGoogleOAuthState(
    value: string | undefined,
    now = Date.now(),
): GoogleOAuthState | null {
    if (!value?.startsWith("v1:")) return null;
    try {
        const parsed = JSON.parse(decryptText(value)) as GoogleOAuthState;
        if (
            typeof parsed.state !== "string" ||
            typeof parsed.verifier !== "string" ||
            typeof parsed.userId !== "string" ||
            typeof parsed.returnTo !== "string" ||
            typeof parsed.expiresAt !== "number" ||
            parsed.expiresAt < now
        ) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/**
 * A path on `appUrl` to return to after connecting; `/dashboard` for
 * anything that would resolve elsewhere. Resolved rather than prefix-checked:
 * URL parsing drops tabs and newlines, so `/\t/evil.example` is `//evil...`.
 */
export function safeReturnTo(
    value: string | null | undefined,
    appUrl: string,
): string {
    if (!value || !value.startsWith("/") || value.length > 1024) {
        return "/dashboard";
    }
    try {
        const base = new URL(appUrl);
        const resolved = new URL(value, base);
        if (resolved.origin !== base.origin) return "/dashboard";
        return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    } catch {
        return "/dashboard";
    }
}
