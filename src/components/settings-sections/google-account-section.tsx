"use client";

import { useExtracted } from "next-intl";
import { GoogleConnectionPanel } from "@/components/integrations/google-connection-panel";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { SettingsCard } from "@/components/settings/settings-card";
import {
    useGoogleConnection,
    useGoogleConnectOutcome,
} from "@/hooks/use-google-connection";

export function GoogleAccountSection() {
    const i18n = useExtracted();
    const { state, refresh } = useGoogleConnection();
    useGoogleConnectOutcome(refresh);

    return (
        <div className="space-y-4">
            <SettingsSectionHeader
                title={i18n("Google account")}
                description={i18n(
                    "Connect a Google Workspace account to export folders to Google Drive. Riffado sees only the files it creates and the folders you pick.",
                )}
            />
            <SettingsCard>
                <GoogleConnectionPanel state={state} onChanged={refresh} />
            </SettingsCard>
        </div>
    );
}
