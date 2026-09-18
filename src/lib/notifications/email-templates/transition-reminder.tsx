import { Button, Heading, Section, Text } from "@react-email/components";
import { getEmailLocale, getEmailTranslator } from "../email-template-i18n";
import { EmailLayout } from "./_layout";
import { formatEmailDate } from "./format-date";
import { formatEmailPrice } from "./format-price";
import { emailStyles } from "./styles";

interface Props {
    /** Days remaining in the free Pro window. */
    daysLeft: number;
    /** End of the free Pro window (when the account goes read-only). */
    transitionEndsAt: Date;
    /** Decimal price string, e.g. "5.00". */
    amountValue: string;
    /** ISO currency code, e.g. "EUR". */
    amountCurrency: string;
    /** Whether a founding monthly spot is currently available. */
    foundingOfferAvailable: boolean;
    foundingCapacity: number;
    /** Settings -> Billing deep link (add a card). */
    billingUrl: string;
    /** Settings -> Export deep link. */
    exportUrl: string;
    /** Self-host docs / repo link. */
    selfHostUrl: string;
}

// Sent ~3 days before the free Pro window closes. States the fork plainly:
// subscribe, self-host, or go read-only. Founding pricing is only shown while
// DB-backed capacity remains. Grandfathered data is never deleted.
export function TransitionReminderEmail({
    daysLeft,
    transitionEndsAt,
    amountValue,
    amountCurrency,
    foundingOfferAvailable,
    foundingCapacity,
    billingUrl,
    exportUrl,
    selfHostUrl,
}: Props) {
    const i18n = getEmailTranslator();
    const locale = getEmailLocale();
    return (
        <EmailLayout
            previewText={i18n(
                "{days, plural, one {# day} other {# days}} of free Hosted Pro left. Choose a plan to keep sync and transcription.",
                { days: daysLeft },
            )}
            footerLink={{ href: billingUrl, label: i18n("Manage billing") }}
        >
            <Heading style={emailStyles.h1}>
                {i18n(
                    "{days, plural, one {# day} other {# days}} of free Hosted Pro left.",
                    { days: daysLeft },
                )}
            </Heading>
            <Text style={emailStyles.text}>
                {i18n("Your free hosted window closes on")}{" "}
                <strong>
                    {formatEmailDate(transitionEndsAt, undefined, locale)}
                </strong>
                {i18n(
                    ". To keep background sync, new transcriptions, and uploads running, choose a plan before then.",
                )}
            </Text>
            {foundingOfferAvailable ? (
                <Text style={emailStyles.text}>
                    {i18n(
                        "Founding monthly spots are still available to the first",
                    )}{" "}
                    {foundingCapacity} {i18n("paid monthly members at")}{" "}
                    {formatEmailPrice(
                        amountValue,
                        amountCurrency,
                        undefined,
                        locale,
                    )}
                    {i18n(
                        ". Once claimed, that price stays locked while the subscription remains active.",
                    )}
                </Text>
            ) : (
                <Text style={emailStyles.text}>
                    {i18n("Monthly Hosted Pro is currently")}{" "}
                    {formatEmailPrice(
                        amountValue,
                        amountCurrency,
                        undefined,
                        locale,
                    )}
                    .
                </Text>
            )}
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={billingUrl}>
                    {foundingOfferAvailable
                        ? i18n("Lock in {price}", {
                              price: formatEmailPrice(
                                  amountValue,
                                  amountCurrency,
                                  undefined,
                                  locale,
                              ),
                          })
                        : i18n("Subscribe")}
                </Button>
            </Section>
            <Text style={emailStyles.text}>
                {i18n(
                    "If you'd rather not subscribe, that's fine. Nothing gets deleted. After",
                )}{" "}
                {formatEmailDate(transitionEndsAt, undefined, locale)}{" "}
                {i18n(
                    "your account goes read-only: your recordings stay playable and exportable, but sync and new transcriptions pause until you subscribe. You can",
                )}{" "}
                <a href={selfHostUrl} style={emailStyles.link}>
                    {i18n("self-host for free")}
                </a>{" "}
                {i18n("or")}{" "}
                <a href={exportUrl} style={emailStyles.link}>
                    {i18n("export everything")}
                </a>{" "}
                {i18n("whenever you want.")}
            </Text>
        </EmailLayout>
    );
}
