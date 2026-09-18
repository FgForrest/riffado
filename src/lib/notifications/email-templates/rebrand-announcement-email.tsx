import { Heading, Text } from "@react-email/components";
import { useExtracted } from "next-intl";
import { EmailLayout } from "./_layout";
import { emailStyles } from "./styles";

interface RebrandAnnouncementEmailProps {
    recipientName: string | null;
    rebrandUrl: string;
    loginUrl: string;
    unsubscribeUrl: string;
}

export function RebrandAnnouncementEmail({
    recipientName,
    rebrandUrl,
    loginUrl,
    unsubscribeUrl,
}: RebrandAnnouncementEmailProps) {
    const i18n = useExtracted();
    const opener = recipientName
        ? i18n("Hey {name},", { name: recipientName })
        : i18n("Hey,");

    return (
        <EmailLayout
            previewText={i18n(
                "OpenPlaud is now Riffado. Same code, same team, new name.",
            )}
            footerLink={{
                href: unsubscribeUrl,
                label: i18n("Unsubscribe from product updates"),
            }}
        >
            <Heading style={emailStyles.h1}>
                {i18n("OpenPlaud is now Riffado.")}
            </Heading>

            <Text style={emailStyles.text}>{opener}</Text>

            <Text style={emailStyles.text}>
                {i18n(
                    "Quick note: the project you signed up for as OpenPlaud is now called Riffado. Same code, same team, same AGPL license. We changed the name because the roadmap is broader than one recorder, and the old name kept boxing us in. That's it.",
                )}
            </Text>

            <Text style={emailStyles.text}>
                {i18n(
                    "Nothing about your account changes. Your recordings, transcripts, summaries, and settings are exactly where you left them. Same prices, same free tier, same self-host install. Your API tokens (the ones starting with",
                )}{" "}
                <span
                    style={{
                        fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, monospace",
                    }}
                >
                    {i18n("op_")}
                </span>{" "}
                {i18n(
                    ") keep working -- nothing to rotate in n8n, Zapier, or any of your scripts.",
                )}
            </Text>

            <Text style={emailStyles.text}>
                {i18n("The main practical change: the URL is")}{" "}
                <a href={loginUrl} style={emailStyles.link}>
                    {i18n("riffado.com")}
                </a>{" "}
                {i18n(
                    "now. The old domain redirects automatically, but update your bookmarks when you get a chance.",
                )}
            </Text>

            <Text style={emailStyles.text}>
                {i18n(
                    "Full story (not a buyout, not an acquisition, not a fork) and the details for self-hosters live at",
                )}{" "}
                <a href={rebrandUrl} style={emailStyles.link}>
                    {i18n("riffado.com/rebrand")}
                </a>
                .
            </Text>

            <Text style={emailStyles.text}>
                {i18n(
                    "If anything broke for you, hit reply. I read this inbox.",
                )}{" "}
                <br /> {i18n("Kacper, from Riffado")}
            </Text>

            <Text style={emailStyles.text}>
                {i18n(
                    "You're receiving this because you have a Riffado (formerly OpenPlaud) account. This is a one-time announcement about the rebrand. You'll still receive transactional email: password resets, sync notifications, and the like.",
                )}
            </Text>
        </EmailLayout>
    );
}
