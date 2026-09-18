import { Button, Heading, Section, Text } from "@react-email/components";
import { useExtracted, useLocale } from "next-intl";
import { EmailLayout } from "./_layout";
import { formatEmailDate } from "./format-date";
import { emailStyles } from "./styles";

interface Props {
    billingUrl: string;
    /** When Stripe next retries the charge (or 'shortly' if unknown). */
    nextRetryAt: Date | null;
    /** When the account will downgrade to Free if the issue isn't resolved. */
    accessUntil: Date | null;
}

function formatDate(d: Date | null, locale: string): string {
    if (!d) return "shortly";
    return formatEmailDate(d, { month: "short" }, locale);
}

export function PaymentFailedEmail({
    billingUrl,
    nextRetryAt,
    accessUntil,
}: Props) {
    const i18n = useExtracted();
    const locale = useLocale();
    return (
        <EmailLayout
            previewText={i18n(
                "Your Riffado Pro payment couldn't be processed. Update your payment method to keep Pro active.",
            )}
            footerLink={{
                href: billingUrl,
                label: i18n("Update payment method"),
            }}
        >
            <Heading style={emailStyles.h1}>{i18n("Payment failed.")}</Heading>
            <Text style={emailStyles.text}>
                {i18n(
                    "We couldn't process this cycle's charge for your Riffado Pro subscription. This usually means the card was declined or the bank flagged the transaction.",
                )}
            </Text>
            <Text style={emailStyles.text}>
                {i18n("Stripe will retry automatically")}{" "}
                {nextRetryAt
                    ? i18n("on {date}", {
                          date: formatDate(nextRetryAt, locale),
                      })
                    : i18n("shortly")}
                .
                {accessUntil
                    ? i18n(
                          " Your Pro access continues until {date}; after that the account drops to Free.",
                          { date: formatDate(accessUntil, locale) },
                      )
                    : i18n(
                          " Your Pro access continues for now; if retries keep failing the account drops to Free.",
                      )}
            </Text>
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={billingUrl}>
                    {i18n("Update payment method")}
                </Button>
            </Section>
        </EmailLayout>
    );
}
