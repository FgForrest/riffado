import {
    Bot,
    BriefcaseBusiness,
    CreditCard,
    type LucideIcon,
    Plug,
    Server,
    SlidersHorizontal,
} from "lucide-react";
import { useExtracted } from "next-intl";

export type MarketingNavLink = {
    label: string;
    href: string;
    description: string;
    icon: LucideIcon;
};

export function useProductNavLinks(): MarketingNavLink[] {
    const i18n = useExtracted();

    return [
        {
            label: i18n("Features"),
            href: "/#features",
            description: i18n(
                "Transcribe, summarize, search, and keep every recording.",
            ),
            icon: SlidersHorizontal,
        },
        {
            label: i18n("Pricing"),
            href: "/#pricing",
            description: i18n(
                "Choose hosted convenience or self-host for free.",
            ),
            icon: CreditCard,
        },
        {
            label: i18n("Self-host"),
            href: "/#deploy",
            description: i18n("Run Riffado on infrastructure you control."),
            icon: Server,
        },
        {
            label: i18n("For Professionals"),
            href: "/for-professionals",
            description: i18n(
                "A private workflow for sensitive conversations.",
            ),
            icon: BriefcaseBusiness,
        },
    ];
}

export function useDocsNavLinks(): MarketingNavLink[] {
    const i18n = useExtracted();

    return [
        {
            label: i18n("Connect your recorder"),
            href: "/docs/guides/connect-plaud-account",
            description: i18n("Bring recordings into Riffado."),
            icon: Plug,
        },
        {
            label: i18n("Choose your AI"),
            href: "/docs/guides/ai-providers",
            description: i18n("Use OpenAI, Anthropic, Groq, or a local model."),
            icon: Bot,
        },
    ];
}

export function useResourceNavLinks() {
    const i18n = useExtracted();

    return [
        { label: i18n("Documentation"), href: "/docs" },
        { label: i18n("Changelog"), href: "/changelog" },
        { label: i18n("Product updates"), href: "/updates" },
    ];
}
