import { Button, Heading, Section, Text } from "@react-email/components";
import { useExtracted } from "next-intl";
import { EmailLayout } from "./_layout";
import { emailStyles } from "./styles";

interface PasswordResetEmailProps {
    resetUrl: string;
}

export function PasswordResetEmail({ resetUrl }: PasswordResetEmailProps) {
    const i18n = useExtracted();
    return (
        <EmailLayout previewText={i18n("Reset your Riffado password")}>
            <Heading style={emailStyles.h1}>
                {i18n("Reset your password")}
            </Heading>
            <Text style={emailStyles.text}>
                {i18n(
                    "We received a request to reset the password for your Riffado account. Click the button below to choose a new password. This link expires in 1 hour.",
                )}
            </Text>
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={resetUrl}>
                    {i18n("Reset password")}
                </Button>
            </Section>
            <Text style={emailStyles.text}>
                {i18n(
                    "If the button doesn't work, paste this URL into your browser:",
                )}
            </Text>
            <Text
                style={{
                    ...emailStyles.text,
                    wordBreak: "break-all",
                    fontSize: "13px",
                }}
            >
                {resetUrl}
            </Text>
            <Text style={emailStyles.text}>
                {i18n(
                    "If you didn't request a password reset, you can safely ignore this email -- your password will not change.",
                )}
            </Text>
        </EmailLayout>
    );
}
