"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    currentLocation,
    type GoogleConnectionState,
    googleConnectUrl,
} from "@/hooks/use-google-connection";
import { getApiErrorMessage } from "@/lib/api-errors";

interface GoogleConnectionPanelProps {
    state: GoogleConnectionState | null;
    onChanged: () => void;
    /** Path to come back to after Google's consent; the current page by default. */
    returnTo?: () => string;
}

/** The user's Google account: connect, reconnect, disconnect. */
export function GoogleConnectionPanel({
    state,
    onChanged,
    returnTo = currentLocation,
}: GoogleConnectionPanelProps) {
    const i18n = useExtracted();
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);

    const connect = () => {
        window.location.assign(googleConnectUrl(returnTo()));
    };

    const disconnect = async () => {
        setBusy(true);
        try {
            const response = await fetch("/api/integrations/google", {
                method: "DELETE",
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not disconnect the Google account"),
                    ),
                );
                return;
            }
            toast.success(i18n("Google account disconnected"));
            setConfirming(false);
            onChanged();
        } finally {
            setBusy(false);
        }
    };

    if (!state) {
        return (
            <p className="text-sm text-muted-foreground">{i18n("Loading…")}</p>
        );
    }
    if (!state.available) {
        return (
            <p className="text-sm text-muted-foreground">
                {i18n(
                    "The Google integration is not configured on this server. It needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_PICKER_API_KEY and GOOGLE_CLOUD_PROJECT_NUMBER.",
                )}
            </p>
        );
    }
    const connection = state.connection;
    if (!connection) {
        return (
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                    {i18n("No Google account is connected.")}
                </p>
                <Button type="button" size="sm" onClick={connect}>
                    {i18n("Connect Google account")}
                </Button>
            </div>
        );
    }
    return (
        <div className="space-y-3">
            {connection.status === "needs_reconnect" ? (
                <p className="text-sm text-destructive">
                    {i18n(
                        "Google no longer accepts Riffado's access to {email}. Exports to Google Drive are paused until you reconnect.",
                        { email: connection.email },
                    )}
                </p>
            ) : (
                <p className="text-sm">
                    {i18n("Connected as {email}", {
                        email: connection.email,
                    })}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                {connection.status === "needs_reconnect" && (
                    <Button type="button" size="sm" onClick={connect}>
                        {i18n("Reconnect")}
                    </Button>
                )}
                {confirming ? (
                    <>
                        <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={busy}
                            onClick={() => void disconnect()}
                        >
                            {i18n("Disconnect and pause Drive exports")}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => setConfirming(false)}
                        >
                            {i18n("Cancel")}
                        </Button>
                    </>
                ) : (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirming(true)}
                    >
                        {i18n("Disconnect")}
                    </Button>
                )}
            </div>
        </div>
    );
}
