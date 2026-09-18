import { Button, Heading, Link, Section, Text } from "@react-email/components";
import { useExtracted } from "next-intl";
import { EmailLayout } from "./_layout";
import { emailStyles } from "./styles";

interface NewRecordingEmailProps {
    count: number;
    recordingNames?: string[];
    dashboardUrl: string;
    settingsUrl: string;
}

const EMPTY_NAMES: string[] = [];

export function NewRecordingEmail({
    count,
    recordingNames = EMPTY_NAMES,
    dashboardUrl,
    settingsUrl,
}: NewRecordingEmailProps) {
    const i18n = useExtracted();
    const syncedLabel = i18n(
        "{count, plural, one {New recording synced} other {# new recordings synced}}",
        { count },
    );

    return (
        <EmailLayout
            previewText={syncedLabel}
            footerLink={{
                href: settingsUrl,
                label: i18n("Manage notifications"),
            }}
        >
            <Heading style={emailStyles.h1}>{syncedLabel}</Heading>

            {recordingNames.length > 0 ? (
                <>
                    <Text style={emailStyles.text}>
                        {i18n(
                            "Your Plaud device synced the following {count, plural, one {recording} other {recordings}}:",
                            { count },
                        )}
                    </Text>

                    <Section style={emailStyles.recordingList}>
                        {recordingNames.slice(0, 10).map((name, index) => (
                            <Link
                                key={name}
                                href={dashboardUrl}
                                style={{
                                    ...emailStyles.recordingItem,
                                    ...(index ===
                                    Math.min(recordingNames.length, 10) - 1
                                        ? emailStyles.recordingItemLast
                                        : {}),
                                }}
                            >
                                <Text style={emailStyles.recordingName}>
                                    {name}
                                </Text>
                            </Link>
                        ))}
                        {recordingNames.length > 10 && (
                            <Text
                                style={{
                                    ...emailStyles.recordingMeta,
                                    marginTop: "8px",
                                }}
                            >
                                {i18n("+{count} more", {
                                    count: String(recordingNames.length - 10),
                                })}
                            </Text>
                        )}
                    </Section>
                </>
            ) : (
                <Text style={emailStyles.text}>
                    {i18n(
                        "Your Plaud device synced {count, plural, one {a new recording} other {# new recordings}} to your dashboard.",
                        { count },
                    )}
                </Text>
            )}

            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={dashboardUrl}>
                    {i18n("View recordings")}
                </Button>
            </Section>
        </EmailLayout>
    );
}
