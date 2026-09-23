"use client";

import { useExtracted } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

export interface GoogleConnectionInfo {
    email: string;
    hostedDomain: string | null;
    status: "active" | "needs_reconnect";
}

export interface GoogleConnectionState {
    available: boolean;
    connection: GoogleConnectionInfo | null;
}

/** Where to send the browser to connect a Google account, then come back. */
export function googleConnectUrl(returnTo: string): string {
    return `/api/integrations/google/connect?returnTo=${encodeURIComponent(returnTo)}`;
}

/** The current page, to come back to after Google's consent screen. */
export function currentLocation(): string {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/** The signed-in user's Google connection, loaded while `enabled`. */
export function useGoogleConnection(enabled = true) {
    const [state, setState] = useState<GoogleConnectionState | null>(null);
    const [loading, setLoading] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const response = await fetch("/api/integrations/google");
            if (!response.ok) return;
            setState((await response.json()) as GoogleConnectionState);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (enabled) void refresh();
    }, [enabled, refresh]);

    return { state, loading, refresh };
}

/**
 * Announces how connecting a Google account ended, once, from the
 * `?google=` parameter the callback appends, then drops the parameter.
 */
export function useGoogleConnectOutcome(onConnected?: () => void) {
    const i18n = useExtracted();
    const announce = useCallback(
        (outcome: string) => {
            switch (outcome) {
                case "connected":
                    toast.success(i18n("Google account connected"));
                    onConnected?.();
                    return;
                case "denied":
                    toast.error(i18n("Google access was not granted"));
                    return;
                case "domain_not_allowed":
                    toast.error(
                        i18n(
                            "That Google account is not in a Workspace domain allowed here",
                        ),
                    );
                    return;
                case "missing_scope":
                    toast.error(
                        i18n(
                            "Google Drive access was not granted. Connect again and allow it.",
                        ),
                    );
                    return;
                case "email_not_verified":
                    toast.error(
                        i18n("That Google account has no verified email"),
                    );
                    return;
                default:
                    toast.error(i18n("Could not connect the Google account"));
            }
        },
        [i18n, onConnected],
    );
    useEffect(() => {
        const url = new URL(window.location.href);
        const outcome = url.searchParams.get("google");
        if (!outcome) return;
        url.searchParams.delete("google");
        window.history.replaceState(window.history.state, "", url);
        // A tick later: the Toaster renders after the page, so it is not
        // listening yet while the page's effects run.
        window.setTimeout(() => announce(outcome), 0);
    }, [announce]);
}
