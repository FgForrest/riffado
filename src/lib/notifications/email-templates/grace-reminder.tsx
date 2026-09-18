import { Button, Heading, Section, Text } from "@react-email/components";
import { useExtracted, useLocale } from "next-intl";
import { EmailLayout } from "./_layout";
import { formatEmailDate } from "./format-date";
import { emailStyles } from "./styles";

interface Props {
    /** Days remaining at send time. */
    daysLeft: number;
    /** When the account will be hard-deleted. */
    deletionAt: Date;
    exportUrl: string;
    reactivateUrl: string;
}

export function GraceReminderEmail({
    daysLeft,
    deletionAt,
    exportUrl,
    reactivateUrl,
}: Props) {
    const i18n = useExtracted();
    const locale = useLocale();
    return (
        <EmailLayout
            previewText={i18n(
                "{days, plural, one {# day} other {# days}} left to export your Riffado data before the account is deleted.",
                { days: daysLeft },
            )}
            footerLink={{
                href: reactivateUrl,
                label: i18n("Reactivate account"),
            }}
        >
            <Heading style={emailStyles.h1}>
                {i18n(
                    "{days, plural, one {# day} other {# days}} left to export.",
                    { days: daysLeft },
                )}
            </Heading>
            <Text style={emailStyles.text}>
                {i18n(
                    "A reminder: your Riffado account and every recording in it will be permanently deleted on",
                )}{" "}
                {formatEmailDate(deletionAt, undefined, locale)}
                {i18n(
                    ". You have {days, plural, one {# day} other {# days}} to export the data or reactivate.",
                    { days: daysLeft },
                )}
            </Text>
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={exportUrl}>
                    {i18n("Export my data")}
                </Button>
            </Section>
            <Text style={emailStyles.text}>
                {i18n("Or")}{" "}
                <a href={reactivateUrl} style={emailStyles.link}>
                    {i18n("add a card to reactivate")}
                </a>{" "}
                {i18n("and pick up where you left off.")}
            </Text>
        </EmailLayout>
    );
}
