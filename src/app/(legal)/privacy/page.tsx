import type { Metadata } from "next";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { getExtracted } from "next-intl/server";
import {
    CONTACT_EMAILS,
    EFFECTIVE_DATE_DISPLAY,
    LEGAL_ADDRESS_LINE,
    LEGAL_ENTITY,
    MIN_AGE,
    RECIPIENT_CATEGORIES,
    SUPERVISORY_AUTHORITY,
} from "@/lib/legal/constants";
import { marketingMetadata } from "@/lib/seo/marketing-metadata";

/*
 * Privacy policy for the HOSTED service only. The `(legal)` layout 404s
 * when `!IS_HOSTED`, so this never serves on a self-hosted instance.
 *
 * Structure follows the GDPR Article 13 information obligations: who the
 * controller is, what we process and why, the legal bases, categories of
 * recipients, transfers, retention, data-subject rights, and the right
 * to lodge a complaint with the supervisory authority.
 *
 * Every factual claim here is traceable to code: AES-256-GCM token
 * encryption (`src/lib/encryption.ts`), full-archive export, account
 * deletion, self-hosted Rybbit analytics, user-configured AI providers.
 * Do not add claims the code does not back. Variable facts (entity,
 * address, recipient categories, contacts) come from
 * `@/lib/legal/constants`.
 */

export async function generateMetadata(): Promise<Metadata> {
    const i18n = await getExtracted();
    return marketingMetadata({
        title: i18n("Privacy Policy | Riffado"),
        description: i18n(
            "How the hosted Riffado service handles your personal data.",
        ),
        path: "/privacy",
    });
}

export default function PrivacyPage() {
    const i18n = useExtracted();
    return (
        <>
            <h1>{i18n("Privacy Policy")}</h1>
            <p>
                <em>
                    {i18n("Effective")} {EFFECTIVE_DATE_DISPLAY}.
                </em>
            </p>
            <p>
                {i18n(
                    "This policy explains how we handle personal data on the hosted Riffado service at riffado.com. Riffado is also open-source software you can run yourself under the AGPL-3.0 license. If you self-host, your data never touches our infrastructure and this policy does not apply to you. See the",
                )}{" "}
                <Link href="https://github.com/riffado/riffado#readme">
                    {i18n("project README")}
                </Link>{" "}
                {i18n("for self-host guidance.")}
            </p>

            <h2>{i18n("Who we are")}</h2>
            <p>
                {i18n("The hosted service is operated by")}{" "}
                {LEGAL_ENTITY.fullName} ({LEGAL_ENTITY.name}),{" "}
                {LEGAL_ENTITY.form}
                {i18n(", with its registered office at")} {LEGAL_ADDRESS_LINE}
                {i18n(
                    ", entered in the National Court Register (KRS) under number",
                )}{" "}
                {LEGAL_ENTITY.krs} {i18n("by the")}{" "}
                {LEGAL_ENTITY.registrationCourt}
                {i18n("; NIP")} {LEGAL_ENTITY.nip}
                {i18n(", REGON")} {LEGAL_ENTITY.regon}
                {i18n("; share capital")} {LEGAL_ENTITY.shareCapital}
                {i18n(
                    ". We are the data controller for the personal data described below. For privacy questions or to exercise your rights, contact",
                )}{" "}
                <Link href={`mailto:${CONTACT_EMAILS.privacy}`}>
                    {CONTACT_EMAILS.privacy}
                </Link>
                .
            </p>

            <h2>{i18n("What we collect")}</h2>
            <ul>
                <li>
                    <strong>{i18n("Account data")}</strong>
                    {i18n(
                        ": the email address and name you provide when you register, and authentication data needed to sign you in.",
                    )}
                </li>
                <li>
                    <strong>{i18n("Connected recorder credentials")}</strong>
                    {i18n(
                        ": the Plaud account token you connect, stored encrypted at rest with AES-256-GCM and decrypted only when we make a request to Plaud on your behalf.",
                    )}
                </li>
                <li>
                    <strong>{i18n("Your content")}</strong>
                    {i18n(
                        ": the recordings, transcripts, and summaries the service syncs or generates for you.",
                    )}
                </li>
                <li>
                    <strong>{i18n("Payment data")}</strong>
                    {i18n(
                        ": if you subscribe, payment details (card number and full billing address) are collected and processed by our payment processor. We store the processor customer and subscription references, subscription status, plan/price, amount, currency, billing interval, billing country, renewal or cancellation dates, withdrawal waiver timestamp, and processor metadata needed to reconcile billing. We never see or store your full card number.",
                    )}
                </li>
                <li>
                    <strong>{i18n("Usage analytics")}</strong>
                    {i18n(
                        ": privacy-friendly, aggregate usage data collected through analytics software we host ourselves. It uses no advertising cookies and is not shared with any third party.",
                    )}
                </li>
            </ul>

            <h2>{i18n("Why we process it, and on what legal basis")}</h2>
            <ul>
                <li>
                    {i18n(
                        "To provide the service: sync, transcription, storage, and export, on the legal basis of performing our contract with you (Art. 6(1)(b) GDPR).",
                    )}
                </li>
                <li>
                    {i18n(
                        "To send transactional email (account verification, billing notifications, grace-period reminders, recording notifications you enable), also as performance of the contract.",
                    )}
                </li>
                <li>
                    {i18n(
                        "To keep the service secure and working, and to understand aggregate usage, on the basis of our legitimate interests (Art. 6(1)(f) GDPR).",
                    )}
                </li>
                <li>
                    {i18n(
                        "When you choose a cloud AI provider, to forward the relevant audio or text to it at your direction so it can transcribe or summarize your content.",
                    )}
                </li>
            </ul>

            <h2>{i18n("What we do not do")}</h2>
            <ul>
                <li>{i18n("We do not train AI models on your recordings.")}</li>
                <li>{i18n("We do not sell your personal data.")}</li>
                <li>
                    {i18n(
                        "We do not use advertising trackers or share data with ad networks.",
                    )}
                </li>
            </ul>

            <h2>{i18n("Who processes data for us")}</h2>
            <p>
                {i18n(
                    "We use the following categories of service providers to run the hosted service. Each handles personal data only on our instructions under a data processing agreement:",
                )}
            </p>
            <div className="overflow-x-auto mb-4">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr className="border-b border-border text-left">
                            <th className="py-2 pr-4 font-semibold text-foreground">
                                {i18n("Category")}
                            </th>
                            <th className="py-2 pr-4 font-semibold text-foreground">
                                {i18n("Purpose")}
                            </th>
                            <th className="py-2 pr-4 font-semibold text-foreground">
                                {i18n("Location")}
                            </th>
                            <th className="py-2 font-semibold text-foreground">
                                {i18n("Safeguard")}
                            </th>
                        </tr>
                    </thead>
                    <tbody className="text-muted-foreground">
                        {RECIPIENT_CATEGORIES.map((p) => (
                            <tr
                                key={p.category}
                                className="border-b border-border/40 align-top"
                            >
                                <td className="py-2 pr-4 text-foreground">
                                    {p.category}
                                </td>
                                <td className="py-2 pr-4">{p.purpose}</td>
                                <td className="py-2 pr-4">{p.location}</td>
                                <td className="py-2">{p.safeguard}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p>
                {i18n(
                    "Our analytics software runs on our own infrastructure, so it is not a third-party recipient of your data.",
                )}
            </p>

            <h2>{i18n("AI providers you configure")}</h2>
            <p>
                {i18n(
                    "When you configure a cloud AI provider (such as OpenAI, Anthropic, or Groq) the service forwards the relevant audio or text to that provider at your direction. You contract with that provider directly and their privacy terms govern that processing. They are not our service providers. We do not retain a separate copy beyond what is already stored in your account. If you transcribe in your browser or with a local model, no audio leaves your control through a third party at all.",
                )}
            </p>

            <h2>{i18n("International transfers")}</h2>
            <p>
                {i18n(
                    "Most processing happens within the European Economic Area. Where a service provider is established outside the EEA (see the table above), transfers are covered by the EU Standard Contractual Clauses and the provider's data processing agreement.",
                )}
            </p>

            <h2>{i18n("Retention")}</h2>
            <p>
                {i18n(
                    "We keep your content and account data for as long as your account is active. If your subscription or trial ends, your account enters a read-only grace period (7 days for accounts that never paid; 30 days for accounts that previously had a subscription). At the end of the grace period, or when you choose to delete your account from Settings, we permanently delete your account and all associated data, including recordings, transcripts, summaries, and stored files, from active storage. Residual copies in routine backups age out on the backup rotation. We keep the minimum records we are legally required to retain.",
                )}
            </p>

            <h2>{i18n("Your rights")}</h2>
            <p>
                {i18n(
                    "Under the GDPR you have the right to access, rectify, erase, restrict, and object to the processing of your personal data, and the right to data portability. You can act on most of these yourself: export every recording, transcript, and summary at any time via the full-archive export, and delete your account to erase your data. For anything else, contact",
                )}{" "}
                <Link href={`mailto:${CONTACT_EMAILS.privacy}`}>
                    {CONTACT_EMAILS.privacy}
                </Link>{" "}
                {i18n("and we will respond within the time the GDPR allows.")}
            </p>
            <p>
                {i18n(
                    "You also have the right to lodge a complaint with a supervisory authority. Our lead authority is",
                )}{" "}
                {SUPERVISORY_AUTHORITY.name}, {SUPERVISORY_AUTHORITY.address} (
                <Link href={SUPERVISORY_AUTHORITY.url}>
                    {SUPERVISORY_AUTHORITY.url.replace("https://", "")}
                </Link>
                ).
            </p>

            <h2>{i18n("Security")}</h2>
            <p>
                {i18n(
                    "Connected recorder tokens and other sensitive credentials are encrypted at rest with AES-256-GCM. Report suspected vulnerabilities to",
                )}{" "}
                <Link href={`mailto:${CONTACT_EMAILS.security}`}>
                    {CONTACT_EMAILS.security}
                </Link>
                .
            </p>

            <h2>{i18n("Children")}</h2>
            <p>
                {i18n(
                    "The hosted service is not directed to children. You must be at least",
                )}{" "}
                {MIN_AGE}{" "}
                {i18n(
                    "years old to use it; if you are under 18, you need a parent or guardian's consent.",
                )}
            </p>

            <h2>{i18n("Compliance posture")}</h2>
            <p>
                {i18n(
                    "Riffado is not HIPAA or SOC 2 certified. For regulated work, self-host the project and plug in an AI provider that signs a data processing agreement you have reviewed, or run a local model.",
                )}
            </p>

            <h2>{i18n("Changes")}</h2>
            <p>
                {i18n(
                    "When we update this policy, we will post the new version here and update the effective date above. We encourage you to review it periodically.",
                )}
            </p>

            <h2>{i18n("Contact")}</h2>
            <p>
                {i18n("Privacy and data requests:")}{" "}
                <Link href={`mailto:${CONTACT_EMAILS.privacy}`}>
                    {CONTACT_EMAILS.privacy}
                </Link>{" "}
                {i18n(". General support:")}{" "}
                <Link href={`mailto:${CONTACT_EMAILS.support}`}>
                    {CONTACT_EMAILS.support}
                </Link>
                .
            </p>
        </>
    );
}
