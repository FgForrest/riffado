import { Button, Heading, Section, Text } from "@react-email/components";
import { getEmailTranslator } from "../email-template-i18n";
import { EmailLayout } from "./_layout";
import { emailStyles } from "./styles";

interface Props {
    verificationUrl: string;
    /** Token expiry in hours (e.g. `24`). */
    expiresInHours: number;
}

export function VerifyEmailEmail({ verificationUrl, expiresInHours }: Props) {
    const i18n = getEmailTranslator();
    return (
        <EmailLayout
            previewText={i18n(
                "Confirm your email address to finish setting up your Riffado account.",
            )}
        >
            <Heading style={emailStyles.h1}>
                {i18n("Confirm your email.")}
            </Heading>
            <Text style={emailStyles.text}>
                {i18n(
                    "Click the button below to confirm this is your email address and finish setting up your Riffado account. The link expires in {hours, plural, one {# hour} other {# hours}}.",
                    { hours: expiresInHours },
                )}
            </Text>
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={verificationUrl}>
                    {i18n("Confirm email")}
                </Button>
            </Section>
            <Text style={emailStyles.text}>
                {i18n(
                    "If you didn't sign up for Riffado, you can safely ignore this message.",
                )}
            </Text>
        </EmailLayout>
    );
}
