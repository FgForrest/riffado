import { Button, Heading, Section, Text } from "@react-email/components";
import { getEmailLocale, getEmailTranslator } from "../email-template-i18n";
import { EmailLayout } from "./_layout";
import { formatEmailDate } from "./format-date";
import { emailStyles } from "./styles";

interface Props {
    /** Which lapse path the user is on -- gates the copy. */
    gracePath: "trial" | "paid";
    /** Total grace window in days (7 for trial, 30 for paid). */
    graceDays: number;
    /** Configured trial length in days (`BILLING_TRIAL_DAYS`, default 14). Only used when `gracePath === "trial"`. */
    trialDays: number;
    /** When the account will be hard-deleted. */
    deletionAt: Date;
    exportUrl: string;
    reactivateUrl: string;
}

export function GraceStartedEmail({
    gracePath,
    graceDays,
    trialDays,
    deletionAt,
    exportUrl,
    reactivateUrl,
}: Props) {
    const i18n = getEmailTranslator();
    const locale = getEmailLocale();
    const heading =
        gracePath === "trial"
            ? i18n("Your trial ended.")
            : i18n("Your subscription ended.");
    const deletionDate = formatEmailDate(deletionAt, undefined, locale);
    const lead =
        gracePath === "trial"
            ? i18n(
                  "Your {trialDays}-day Riffado Pro trial ended without a card on file. You have {graceDays, plural, one {# day} other {# days}} to export your data; after that, your account and all recordings will be permanently deleted on {deletionDate}.",
                  { trialDays: String(trialDays), graceDays, deletionDate },
              )
            : i18n(
                  "Your Riffado Pro subscription ended. You have {graceDays, plural, one {# day} other {# days}} to export your data or reactivate. After {deletionDate} your account and all recordings will be permanently deleted.",
                  { graceDays, deletionDate },
              );
    return (
        <EmailLayout
            previewText={i18n(
                "You have {days, plural, one {# day} other {# days}} to export your Riffado data before the account is deleted.",
                { days: graceDays },
            )}
            footerLink={{
                href: reactivateUrl,
                label: i18n("Reactivate account"),
            }}
        >
            <Heading style={emailStyles.h1}>{heading}</Heading>
            <Text style={emailStyles.text}>{lead}</Text>
            <Text style={emailStyles.text}>
                {i18n(
                    "Until then, your recordings are still playable and your data is fully exportable. Sync from your device and new transcriptions are paused.",
                )}
            </Text>
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={exportUrl}>
                    {i18n("Export my data")}
                </Button>
            </Section>
            <Text style={emailStyles.text}>
                {i18n("Changed your mind?")}{" "}
                <a href={reactivateUrl} style={emailStyles.link}>
                    {i18n("Add a card to reactivate")}
                </a>{" "}
                {i18n(". Everything resumes instantly, and nothing is lost.")}
            </Text>
            <Text style={emailStyles.text}>
                {i18n(
                    "Questions, or something looks off? Reply to this email. I read every one.",
                )}{" "}
                <br /> {i18n("Kacper, Riffado")}
            </Text>
        </EmailLayout>
    );
}
