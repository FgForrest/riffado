import { Button, Heading, Section, Text } from "@react-email/components";
import { useExtracted, useLocale } from "next-intl";
import { EmailLayout } from "./_layout";
import { formatEmailDate } from "./format-date";
import { emailStyles } from "./styles";

interface Props {
    /** When the account will be hard-deleted (within the next ~24h). */
    deletionAt: Date;
    exportUrl: string;
    reactivateUrl: string;
}

export function GraceLastDayEmail({
    deletionAt,
    exportUrl,
    reactivateUrl,
}: Props) {
    const i18n = useExtracted();
    const locale = useLocale();
    return (
        <EmailLayout
            previewText={i18n(
                "Last chance: your Riffado account is deleted in under 24 hours.",
            )}
            footerLink={{
                href: reactivateUrl,
                label: i18n("Reactivate account"),
            }}
        >
            <Heading style={emailStyles.h1}>
                {i18n("Last chance to export.")}
            </Heading>
            <Text style={emailStyles.text}>
                {i18n(
                    "Your Riffado account is scheduled for permanent deletion on",
                )}{" "}
                {formatEmailDate(
                    deletionAt,
                    { month: "short", includeTime: true },
                    locale,
                )}{" "}
                {i18n(
                    ". That's under 24 hours from now. Every recording, transcript, and summary will be removed and cannot be recovered.",
                )}
            </Text>
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={exportUrl}>
                    {i18n("Export now")}
                </Button>
            </Section>
            <Text style={emailStyles.text}>
                {i18n("Want to keep your account?")}{" "}
                <a href={reactivateUrl} style={emailStyles.link}>
                    {i18n("Add a card to reactivate")}
                </a>{" "}
                {i18n(". Reactivation is instant, with no data loss.")}
            </Text>
        </EmailLayout>
    );
}
