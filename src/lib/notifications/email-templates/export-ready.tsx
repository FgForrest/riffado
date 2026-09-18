import { Button, Heading, Section, Text } from "@react-email/components";
import { getEmailTranslator } from "../email-template-i18n";
import { EmailLayout } from "./_layout";
import { emailStyles } from "./styles";

interface Props {
    downloadUrl: string;
}

export function ExportReadyEmail({ downloadUrl }: Props) {
    const i18n = getEmailTranslator();
    return (
        <EmailLayout
            previewText={i18n("Your Riffado data export is ready to download.")}
            footerLink={{ href: downloadUrl, label: i18n("Download export") }}
        >
            <Heading style={emailStyles.h1}>
                {i18n("Your export is ready")}
            </Heading>
            <Text style={emailStyles.text}>
                {i18n(
                    "We finished building your full data archive: every recording's audio, transcript, and AI summary, zipped up and ready to download.",
                )}
            </Text>
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={downloadUrl}>
                    {i18n("Download export")}
                </Button>
            </Section>
            <Text style={emailStyles.text}>
                {i18n("The download link stays active for 7 days.")}
            </Text>
        </EmailLayout>
    );
}
