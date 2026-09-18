import {
    Button,
    Column,
    Heading,
    Hr,
    Row,
    Section,
    Text,
} from "@react-email/components";
import type { ReactNode } from "react";
import { getEmailLocale, getEmailTranslator } from "../email-template-i18n";
import { EmailLayout } from "./_layout";
import { formatEmailDate } from "./format-date";
import { formatEmailPrice } from "./format-price";
import { emailStyles } from "./styles";

/**
 * Bulletproof hanging-indent bullet (table row, not CSS text-indent --
 * see `emailStyles.bulletGlyphColumn`). `margin` defaults to the
 * between-items gap; pass "0 0 16px 0" for the last bullet in a list.
 */
function Bullet({
    children,
    margin = "0 0 8px 0",
}: {
    children: ReactNode;
    margin?: string;
}) {
    const i18n = getEmailTranslator();
    return (
        <Row style={{ margin }}>
            <Column style={emailStyles.bulletGlyphColumn}>
                {i18n("&bull;")}
            </Column>
            <Column style={emailStyles.bulletTextColumn}>{children}</Column>
        </Row>
    );
}

interface Props {
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

// Sent once to the grandfathered pre-launch cohort, replacing the earlier
// purely transactional version of this email. Tone: personal, honest about
// why hosted is now paid, and explicit that self-host stays a fully equal
// path, not a downgrade. The account-specific facts (deadline, price,
// read-only consequence, "nothing deleted") stay in their own clearly
// separated section rather than dissolving into the narrative -- this is
// a notice of an account change as much as it is a story, and readers
// need to be able to find the mechanics without reading the whole letter.
export function TransitionStartEmail({
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
    const deadline = formatEmailDate(transitionEndsAt, undefined, locale);
    return (
        <EmailLayout
            previewText={i18n(
                "Hosted Pro is live. The essentials are at the top; the story's below. Nothing changes until {deadline}.",
                { deadline },
            )}
            footerLink={{ href: billingUrl, label: i18n("Manage billing") }}
        >
            <Heading style={emailStyles.h1}>
                {i18n("Hosted Pro is here.")}
            </Heading>

            <Text style={emailStyles.eyebrow}>{i18n("In short")}</Text>
            <Bullet>
                {i18n("You keep full free access until")}{" "}
                <strong>{deadline}</strong>
                {i18n(". Nothing changes today.")}
            </Bullet>
            {foundingOfferAvailable ? (
                <Bullet>
                    {i18n("After that, Hosted Pro is")}{" "}
                    <strong>
                        {formatEmailPrice(
                            amountValue,
                            amountCurrency,
                            undefined,
                            locale,
                        )}
                    </strong>{" "}
                    {i18n(
                        ", locked in for as long as you stay subscribed, for the first",
                    )}{" "}
                    {foundingCapacity}{" "}
                    {i18n("paid monthly members (first-paid, first-served).")}
                </Bullet>
            ) : (
                <Bullet>
                    {i18n("After that, Hosted Pro is")}{" "}
                    <strong>
                        {formatEmailPrice(
                            amountValue,
                            amountCurrency,
                            undefined,
                            locale,
                        )}
                    </strong>
                    .
                </Bullet>
            )}
            <Bullet>
                {i18n(
                    "If you don't act, your account goes read-only. Nothing gets deleted.",
                )}
            </Bullet>
            <Bullet margin="0">
                {i18n("Self-hosting stays free forever. That's not changing.")}
            </Bullet>
            <Hr style={{ ...emailStyles.divider, margin: "20px 0 24px 0" }} />

            <Text style={emailStyles.text}>
                {i18n("Here's the story behind that, if you want it.")}
            </Text>

            <Text style={emailStyles.text}>
                {i18n(
                    "Riffado started as a simple idea: your recordings and transcripts should belong to you, and you should choose which AI touches them. That part worked. But hosted Riffado runs on real infrastructure: servers, storage for your audio, and the compute behind Mynah, the transcription service included with Hosted Pro. Free hosting was the right call for an early cohort helping us find the rough edges. Thank you for that. It's not something we can run forever on goodwill, so Hosted Pro is now a paid plan.",
                )}
            </Text>

            <Text style={emailStyles.text}>
                {i18n(
                    "A subscription is the most honest way to fund this: no ads, no selling your data, no lock-in. And because Riffado is one AGPL codebase, everything a Hosted Pro subscription funds ships to self-hosters too. Paying for Hosted Pro pays for the project, not just your own account.",
                )}
            </Text>

            <Text style={emailStyles.text}>
                {i18n(
                    "That also means self-hosting isn't going anywhere. The source stays AGPL-3.0, and the exact code running Hosted is the code you can",
                )}{" "}
                <a href={selfHostUrl} style={emailStyles.link}>
                    {i18n("run yourself")}
                </a>{" "}
                {i18n(
                    ": your machine, your storage, free forever. Self-host and Hosted Pro are the same project, run two different ways.",
                )}
            </Text>

            <Text style={emailStyles.text}>
                {i18n(
                    "Hosted Pro includes 50 GB of storage, 15 hours of Mynah transcription every month, unlimited devices, and background sync that keeps pulling recordings even when your browser is closed. Bring your own AI key if you'd rather (OpenAI, Groq, anything compatible); Riffado adds no markup when you do.",
                )}
            </Text>

            <Hr style={emailStyles.divider} />

            <Heading style={emailStyles.h2}>
                {i18n("What this means for your account")}
            </Heading>

            <Bullet>
                {i18n("Your access stays free until")}{" "}
                <strong>{deadline}</strong>.
            </Bullet>
            {foundingOfferAvailable ? (
                <Bullet>
                    {i18n(
                        "As an early user, you can lock in the founding price of",
                    )}{" "}
                    <strong>
                        {formatEmailPrice(
                            amountValue,
                            amountCurrency,
                            undefined,
                            locale,
                        )}
                    </strong>{" "}
                    {i18n(", limited to the first")} {foundingCapacity}{" "}
                    {i18n("paid monthly members, first-paid, first-served.")}
                </Bullet>
            ) : (
                <Bullet>
                    {i18n("Monthly Hosted Pro is available for")}{" "}
                    <strong>
                        {formatEmailPrice(
                            amountValue,
                            amountCurrency,
                            undefined,
                            locale,
                        )}
                    </strong>
                    .
                </Bullet>
            )}
            <Bullet margin="0 0 16px 0">
                {i18n(
                    "You can cancel anytime. Canceling starts a grace period, so nothing is lost immediately even then.",
                )}
            </Bullet>

            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={billingUrl}>
                    {foundingOfferAvailable
                        ? i18n("Claim founding price")
                        : i18n("Choose a plan")}
                </Button>
            </Section>

            <Text style={emailStyles.text}>
                {i18n("If you don't choose a plan by")} {deadline}
                {i18n(
                    ", your account becomes read-only. Nothing gets deleted: every recording, transcript, and summary stays playable and exportable. Sync, uploads, and new transcriptions pause until you subscribe,",
                )}{" "}
                <a href={exportUrl} style={emailStyles.link}>
                    {i18n("export")}
                </a>{" "}
                {i18n(", or self-host.")}
            </Text>

            <Text style={emailStyles.text}>
                {i18n(
                    "Questions, or something looks off? Reply. It comes straight to me, and I read this inbox.",
                )}{" "}
                <br /> {i18n("Kacper, building Riffado")}
            </Text>
        </EmailLayout>
    );
}
