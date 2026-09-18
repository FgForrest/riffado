import { Button, Heading, Section, Text } from "@react-email/components";
import { getEmailTranslator } from "../email-template-i18n";
import { EmailLayout } from "./_layout";
import { emailStyles } from "./styles";

interface TestEmailProps {
    dashboardUrl: string;
    settingsUrl: string;
}

export function TestEmail({ dashboardUrl, settingsUrl }: TestEmailProps) {
    const i18n = getEmailTranslator();
    return (
        <EmailLayout
            previewText={i18n(
                "Test email from Riffado - Email notifications are working",
            )}
            footerLink={{
                href: settingsUrl,
                label: i18n("Manage notifications"),
            }}
        >
            <Heading style={emailStyles.h1}>{i18n("Test email")}</Heading>
            <Text style={emailStyles.text}>
                {i18n(
                    "Your email notifications are configured correctly. You'll receive an email when new recordings are synced from your Plaud device.",
                )}
            </Text>
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={dashboardUrl}>
                    {i18n("Open dashboard")}
                </Button>
            </Section>
        </EmailLayout>
    );
}
