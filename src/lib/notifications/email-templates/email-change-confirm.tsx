import { Button, Heading, Section, Text } from "@react-email/components";
import { getEmailTranslator } from "../email-template-i18n";
import { EmailLayout } from "./_layout";
import { emailStyles } from "./styles";

interface Props {
    confirmUrl: string;
    /** The new address the user is moving to. */
    newEmail: string;
    /** Token expiry in hours. */
    expiresInHours: number;
}

export function EmailChangeConfirmEmail({
    confirmUrl,
    newEmail,
    expiresInHours,
}: Props) {
    const i18n = getEmailTranslator();
    return (
        <EmailLayout
            previewText={i18n(
                "Confirm the email change on your Riffado account.",
            )}
        >
            <Heading style={emailStyles.h1}>
                {i18n("Confirm email change.")}
            </Heading>
            <Text style={emailStyles.text}>
                {i18n(
                    "A change request was made to update the email on your Riffado account to {newEmail}. Click below to confirm. The link expires in {hours, plural, one {# hour} other {# hours}}.",
                    { newEmail, hours: expiresInHours },
                )}
            </Text>
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={confirmUrl}>
                    {i18n("Confirm new email")}
                </Button>
            </Section>
            <Text style={emailStyles.text}>
                {i18n(
                    "If you did not request this change, ignore this message and consider rotating your password.",
                )}
            </Text>
        </EmailLayout>
    );
}
