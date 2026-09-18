import { Heading, Text } from "@react-email/components";
import { getEmailTranslator } from "../email-template-i18n";
import { EmailLayout } from "./_layout";
import { emailStyles } from "./styles";

interface Props {
    signupUrl: string;
}

export function AccountDeletedEmail({ signupUrl }: Props) {
    const i18n = getEmailTranslator();
    return (
        <EmailLayout
            previewText={i18n("Your Riffado account has been deleted.")}
        >
            <Heading style={emailStyles.h1}>{i18n("Account deleted.")}</Heading>
            <Text style={emailStyles.text}>
                {i18n(
                    "Your Riffado account, recordings, transcripts, and summaries have been permanently deleted. We don't keep backups of deleted user data, so this is irreversible.",
                )}
            </Text>
            <Text style={emailStyles.text}>
                {i18n(
                    "Thanks for trying Riffado. If you change your mind, you can always",
                )}{" "}
                <a href={signupUrl} style={emailStyles.link}>
                    {i18n("start fresh")}
                </a>{" "}
                {i18n("or self-host the open-source version at")}{" "}
                <a
                    href="https://github.com/riffado/riffado"
                    style={emailStyles.link}
                >
                    {i18n("github.com/riffado/riffado")}
                </a>
                .
            </Text>
        </EmailLayout>
    );
}
