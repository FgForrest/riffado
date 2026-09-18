import { Button, Heading, Section, Text } from "@react-email/components";
import { getEmailLocale, getEmailTranslator } from "../email-template-i18n";
import { EmailLayout } from "./_layout";
import { formatEmailPrice } from "./format-price";
import { emailStyles } from "./styles";

interface Props {
    /** Decimal price string, e.g. "5.00". */
    amountValue: string;
    /** ISO currency code, e.g. "EUR". */
    amountCurrency: string;
    /** Settings -> Billing deep link (subscribe / resume). */
    billingUrl: string;
    /** Settings -> Export deep link. */
    exportUrl: string;
    /** Self-host docs / repo link. */
    selfHostUrl: string;
}

// Sent when the free Pro window has closed and the account is now read-only.
// No deletion clock for the grandfathered cohort: data stays put indefinitely
// until they subscribe, export, or self-host.
export function TransitionEndedEmail({
    amountValue,
    amountCurrency,
    billingUrl,
    exportUrl,
    selfHostUrl,
}: Props) {
    const i18n = getEmailTranslator();
    const locale = getEmailLocale();
    return (
        <EmailLayout
            previewText={i18n(
                "Your hosted account is now read-only. Your data is safe, and you can subscribe anytime to resume.",
            )}
            footerLink={{ href: billingUrl, label: i18n("Manage billing") }}
        >
            <Heading style={emailStyles.h1}>
                {i18n("Your free Hosted Pro window has ended.")}
            </Heading>
            <Text style={emailStyles.text}>
                {i18n(
                    "Your account is now read-only. Your recordings, transcripts, and summaries are all still here and fully exportable, but sync, uploads, and new transcriptions are paused until you subscribe.",
                )}
            </Text>
            <Text style={emailStyles.text}>
                {i18n(
                    "Nothing will be deleted. Pick this back up whenever you're ready. Subscribe and everything resumes instantly at",
                )}{" "}
                {formatEmailPrice(
                    amountValue,
                    amountCurrency,
                    undefined,
                    locale,
                )}
                .
            </Text>
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={billingUrl}>
                    {i18n("Subscribe and resume")}
                </Button>
            </Section>
            <Text style={emailStyles.text}>
                {i18n("Want to keep Riffado free? You can")}{" "}
                <a href={selfHostUrl} style={emailStyles.link}>
                    {i18n("self-host")}
                </a>{" "}
                {i18n(
                    "the open-source version and bring your data with you. You can",
                )}{" "}
                <a href={exportUrl} style={emailStyles.link}>
                    {i18n("export everything here")}
                </a>
                .
            </Text>
        </EmailLayout>
    );
}
