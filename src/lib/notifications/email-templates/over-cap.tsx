import { Button, Heading, Section, Text } from "@react-email/components";
import { useExtracted } from "next-intl";
import { EmailLayout } from "./_layout";
import { emailStyles } from "./styles";

interface Props {
    billingUrl: string;
    settingsUrl: string;
    /** Current storage usage in bytes. */
    currentBytes: number;
    /** Free-tier storage cap in bytes. */
    limitBytes: number;
}

function formatGB(bytes: number): string {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function OverCapEmail({
    billingUrl,
    settingsUrl,
    currentBytes,
    limitBytes,
}: Props) {
    const i18n = useExtracted();
    return (
        <EmailLayout
            previewText={i18n(
                "Your Riffado account is over the Free storage limit. Sync of new objects is paused until you upgrade or free up space.",
            )}
            footerLink={{ href: settingsUrl, label: i18n("Open settings") }}
        >
            <Heading style={emailStyles.h1}>
                {i18n("You're over the Free cap.")}
            </Heading>
            <Text style={emailStyles.text}>
                {i18n("Your account is using")} {formatGB(currentBytes)}{" "}
                {i18n("of the")} {formatGB(limitBytes)}{" "}
                {i18n("Free-tier storage cap.")}
            </Text>
            <Text style={emailStyles.text}>
                {i18n(
                    "Your data is safe and your existing recordings still play. We've paused sync of",
                )}{" "}
                <em>{i18n("new")}</em>{" "}
                {i18n(
                    "objects from Plaud until you either upgrade to Pro (50 GB cap) or delete enough recordings to come back under the limit.",
                )}
            </Text>
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={billingUrl}>
                    {i18n("Upgrade to Pro")}
                </Button>
            </Section>
        </EmailLayout>
    );
}
