import type { CampaignKind } from "@/db/queries/email-campaigns";
import type { AppLocale } from "@/lib/i18n/config";

export type { CampaignKind };

export interface Recipient {
    kind: "user" | "subscriber";
    id: string;
    email: string;
    name: string | null;
    marketingConsent: boolean | null;
    locale?: AppLocale;
}

export interface RenderedEmail {
    html: string;
    text?: string;
    subject?: string;
}

export interface CampaignDefinition {
    slug: string;
    subject: string;
    kind: CampaignKind;
    audience: () => AsyncIterable<Recipient>;
    render: (
        recipient: Recipient,
        unsubscribeUrl: string | null,
    ) => Promise<RenderedEmail>;
    fromAddress?: string;
}
