import { Button, Heading, Section, Text } from "@react-email/components";
import { getEmailLocale, getEmailTranslator } from "../email-template-i18n";
import { EmailLayout } from "./_layout";
import { formatEmailPrice } from "./format-price";
import { emailStyles } from "./styles";

interface Props {
    dashboardUrl: string;
    settingsUrl: string;
    /** True iff the user currently has active founding monthly pricing. */
    foundingMember: boolean;
    /**
     * 1-indexed founding-member rank (e.g. `47` of `foundingCapacity`).
     * Null when the user isn't a founding member, or the rank couldn't
     * be resolved -- the founding paragraph then falls back to the
     * cohort-only phrasing.
     */
    foundingRank: number | null;
    foundingCapacity: number;
    amountValue: string;
    amountCurrency: string;
    /** Billing interval of the subscription that triggered this email. */
    interval: "month" | "year";
    /** Recordings synced before this upgrade. 0 for a brand-new account. */
    recordingCount: number;
    totalDurationMs: number;
}

export function WelcomeHostedProEmail({
    dashboardUrl,
    settingsUrl,
    foundingMember,
    foundingRank,
    foundingCapacity,
    amountValue,
    amountCurrency,
    interval,
    recordingCount,
    totalDurationMs,
}: Props) {
    const i18n = getEmailTranslator();
    const locale = getEmailLocale();
    const hours = Math.round(totalDurationMs / 3_600_000);
    const isFoundingMonthly = foundingMember && interval === "month";
    return (
        <EmailLayout
            previewText={i18n(
                "You're on Riffado Hosted Pro: 50 GB storage, 15 hours of Mynah transcription, unlimited devices.",
            )}
            footerLink={{
                href: settingsUrl,
                label: i18n("Manage subscription"),
            }}
        >
            <Heading style={emailStyles.h1}>
                {i18n("You're on Hosted Pro.")}
            </Heading>
            {recordingCount > 0 ? (
                <Text style={emailStyles.text}>
                    {i18n(
                        "Thanks for upgrading. You've already synced {recordings, plural, one {# recording} other {# recordings}}{hours, plural, =0 {} one { (about # hour of audio)} other { (about # hours of audio)}}. Sync and transcription keep running without interruption, and your Pro entitlements are live:",
                        { recordings: recordingCount, hours },
                    )}
                </Text>
            ) : (
                <Text style={emailStyles.text}>
                    {i18n(
                        "Thanks for upgrading. Your subscription is active and your Pro entitlements are live:",
                    )}
                </Text>
            )}
            <Text style={{ ...emailStyles.text, margin: "0 0 6px 0" }}>
                {i18n("• 50 GB storage")}
            </Text>
            <Text style={{ ...emailStyles.text, margin: "0 0 6px 0" }}>
                {i18n(
                    "• 15 hours of Mynah transcription, refreshed every 30 days",
                )}
            </Text>
            <Text style={{ ...emailStyles.text, margin: "0 0 16px 0" }}>
                {i18n("• Unlimited devices, background sync")}
            </Text>
            {isFoundingMonthly ? (
                <Text style={emailStyles.text}>
                    {foundingRank
                        ? i18n(
                              "You're founding member #{rank} of {capacity}.",
                              {
                                  rank: String(foundingRank),
                                  capacity: String(foundingCapacity),
                              },
                          )
                        : i18n(
                              "You subscribed during the founding-member window.",
                          )}{" "}
                    {i18n("Your monthly price is locked at")}{" "}
                    {formatEmailPrice(
                        amountValue,
                        amountCurrency,
                        undefined,
                        locale,
                    )}{" "}
                    {i18n(
                        "for as long as your subscription stays active. Thanks for being early.",
                    )}
                </Text>
            ) : null}
            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={dashboardUrl}>
                    {i18n("Open Riffado")}
                </Button>
            </Section>
            <Text style={emailStyles.text}>
                {i18n(
                    "\"Email support\" isn't a ticket queue here. Reply to this email if anything's off or you have a question. It reaches me directly.",
                )}{" "}
                <br /> {i18n("Kacper, building Riffado")}
            </Text>
        </EmailLayout>
    );
}
