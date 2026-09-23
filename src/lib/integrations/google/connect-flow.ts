import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import { GOOGLE_DRIVE_FILE_SCOPE, getGoogleIntegrationConfig } from "./config";
import { saveGoogleConnection } from "./connection";
import { exchangeAuthorizationCode, readIdTokenClaims } from "./oauth";
import { openGoogleOAuthState } from "./oauth-state";

export type GoogleConnectOutcome =
    | "connected"
    | "denied"
    | "invalid_state"
    | "domain_not_allowed"
    | "email_not_verified"
    | "missing_scope"
    | "failed";

export interface GoogleConnectResult {
    outcome: GoogleConnectOutcome;
    /** Where to send the browser; a same-origin path. */
    returnTo: string;
}

/**
 * Finishes connecting a Google account after Google redirects back.
 *
 * The sealed cookie must match the `state` Google echoes and the user now
 * signed in, so a callback started by someone else cannot attach their
 * account to this user. Workspace domain and scopes are checked before
 * anything is stored: granular consent lets a user untick Drive.
 */
export async function completeGoogleConnect(input: {
    userId: string;
    sealedState: string | undefined;
    params: URLSearchParams;
    fetchImpl?: typeof fetch;
}): Promise<GoogleConnectResult> {
    const sealed = openGoogleOAuthState(input.sealedState);
    const state = input.params.get("state");
    if (!sealed || !state || sealed.state !== state) {
        return { outcome: "invalid_state", returnTo: "/dashboard" };
    }
    const returnTo = sealed.returnTo;
    if (sealed.userId !== input.userId) {
        return { outcome: "invalid_state", returnTo };
    }
    if (input.params.get("error")) return { outcome: "denied", returnTo };
    const code = input.params.get("code");
    const config = getGoogleIntegrationConfig();
    if (!code || !config) return { outcome: "failed", returnTo };

    try {
        const tokens = await exchangeAuthorizationCode(
            { config, code, codeVerifier: sealed.verifier },
            input.fetchImpl,
        );
        if (!tokens.idToken) return { outcome: "failed", returnTo };
        const claims = readIdTokenClaims(tokens.idToken);
        if (!claims.emailVerified) {
            return { outcome: "email_not_verified", returnTo };
        }
        if (
            config.workspaceDomains.length > 0 &&
            !config.workspaceDomains.includes(claims.hostedDomain ?? "")
        ) {
            return { outcome: "domain_not_allowed", returnTo };
        }
        if (!tokens.scopes.includes(GOOGLE_DRIVE_FILE_SCOPE)) {
            return { outcome: "missing_scope", returnTo };
        }
        await saveGoogleConnection(input.userId, claims, tokens);
    } catch (error) {
        console.error("[google] connecting an account failed:", error);
        return { outcome: "failed", returnTo };
    }
    // Exports paused by a lost connection pick up where they stopped.
    await enqueueExportPlansForUser(input.userId).catch((error) => {
        console.error("[google] could not re-plan exports:", error);
    });
    return { outcome: "connected", returnTo };
}

/** `returnTo` with the outcome appended as `?google=<outcome>`. */
export function returnUrlWithOutcome(
    returnTo: string,
    outcome: GoogleConnectOutcome,
    appUrl: string,
): URL {
    const url = new URL(returnTo, appUrl);
    url.searchParams.set("google", outcome);
    return url;
}
