import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { listUserProviders } from "@/lib/ai/list-providers";
import { requireAuth, requireCompletedOnboarding } from "@/lib/auth-server";
import { env } from "@/lib/env";
import { isMailEnabled } from "@/lib/mail/config";
import { isOrgAccount } from "@/lib/org/config";

export default async function SettingsPage() {
    const session = await requireAuth();
    await requireCompletedOnboarding(session);

    const [providers, orgAccount] = await Promise.all([
        listUserProviders(session.user.id),
        isOrgAccount(session.user.id),
    ]);

    return (
        <SettingsPageContent
            initialProviders={providers}
            isHosted={env.IS_HOSTED}
            mailEnabled={isMailEnabled() && !orgAccount}
        />
    );
}
