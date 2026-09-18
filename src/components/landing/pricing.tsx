import { Check } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { MetalButton } from "@/components/metal-button";
import type { FoundingMemberAvailabilityRow } from "@/db/queries/billing";
import {
    type BillingCurrency,
    billingPriceCatalog,
    type PublicPrice,
    pickDisplayPrice,
    trimDisplayAmount,
} from "@/lib/hosted/billing/pricing";

/**
 * Two ways to run Riffado. Same source. Pay for someone else to run
 * the server, or run it yourself for free.
 *
 * Design rules (read before editing):
 *
 * - Chrome is inherited from `the-math.tsx`: same `rounded-2xl`,
 *   same `bg-card` / `bg-card/50` pairing, same mono uppercase
 *   eyebrow, same tabular-nums price treatment. The two sections
 *   are intended to read as a single argument; do not introduce a
 *   second visual system here.
 *
 * - Two tiers only. There is no Hosted Free plan. The historical
 *   "Hosted Free" column was removed when the hosted product moved
 *   to a Pro-only model with a 14-day trial. Anyone who wants
 *   Riffado free runs it themselves. That positioning is the whole
 *   reason for the two-column layout -- restoring a "Hosted Free"
 *   sibling here will reintroduce the freemium-funnel mistake we
 *   explicitly rejected.
 *
 * - Hosted Pro carries emphasis. Self-host is the equal sibling,
 *   not a downgrade. The point is "two valid paths," not "free
 *   teaser + real product."
 *
 * - Feature copy names real vendors (OpenAI, Groq, Whisper) instead
 *   of "OpenAI-compatible providers." Per AGENTS.md positioning:
 *   category noun leads, named examples follow, "+ any
 *   OpenAI-compatible" is the escape hatch in small print -- never
 *   single-vendor framing that implies a default cloud.
 *
 * - Hosted Pro numbers (50 GB / 15 hr / unlimited devices) come from
 *   the entitlements catalog in `src/lib/entitlements.ts` and the
 *   `BILLING_PRO_*` env vars. If those move, update this copy in
 *   the same commit. Do not invent numbers that don't match the
 *   billing layer.
 *
 * - Trial copy is "14-day Pro trial, no card required." That's the
 *   actual signup flow. Founding-member (price locked for life) is
 *   the conversion lever; surface it visibly in the Hosted Pro
 *   column so the offer reaches users before they click through.
 *
 * - Prices are derived from `BILLING_PRICE_USD` / `BILLING_PRICE_EUR`
 *   (headline in USD; EU buyers are billed EUR, VAT included --
 *   Stripe Checkout localizes the real charge from the buyer's
 *   country). Annual availability and its amounts come from the
 *   billing price catalog; never invent an annual amount or a
 *   discount claim here. Founding-member copy is monthly-only --
 *   the price lock never applies to annual subscriptions.
 */
type Tier = {
    name: string;
    price: string;
    compareAtPrice?: string;
    priceSuffix: string;
    tagline: string;
    pill: { label: string; tone: "muted" | "primary" } | null;
    features: string[];
    cta: { label: string; href: string };
    emphasis: boolean;
    /** Optional small print under the feature list. */
    note?: string;
};

function formatCatalogPrice(price: PublicPrice, suffix: string): string {
    const symbol = price.currency === "usd" ? "$" : "€";
    const amount = price.displayAmount
        ? trimDisplayAmount(price.displayAmount)
        : null;
    return amount ? `${symbol}${amount}${suffix}` : "";
}

export function Pricing({
    availability,
    monthlyCurrency,
    annualCurrency,
}: {
    availability: FoundingMemberAvailabilityRow;
    monthlyCurrency: BillingCurrency;
    annualCurrency: BillingCurrency;
}) {
    const i18n = useExtracted();
    const catalog = billingPriceCatalog(availability);
    const primaryMonthly =
        availability.remaining > 0
            ? pickDisplayPrice(catalog.monthly.founding, monthlyCurrency)
            : pickDisplayPrice(catalog.monthly.standard, monthlyCurrency);
    const headlinePrice = primaryMonthly
        ? formatCatalogPrice(primaryMonthly, "")
        : null;
    const comparisonMonthly = pickDisplayPrice(
        catalog.monthly.standard,
        primaryMonthly?.currency ?? monthlyCurrency,
    );
    const compareAtPrice =
        availability.remaining > 0 && comparisonMonthly
            ? formatCatalogPrice(comparisonMonthly, "")
            : undefined;
    const foundingMonthly = pickDisplayPrice(
        catalog.monthly.founding,
        monthlyCurrency,
    );
    const standardMonthly = pickDisplayPrice(
        catalog.monthly.standard,
        monthlyCurrency,
    );
    const annual = pickDisplayPrice(catalog.annual, annualCurrency);
    const annualNote = annual
        ? i18n(
              " Prefer to pay yearly? Annual billing is available at {price}.",
              { price: formatCatalogPrice(annual, i18n("/year")) },
          )
        : "";
    const foundingNote =
        foundingMonthly && availability.remaining > 0
            ? i18n(
                  " {remaining, plural, one {# founding monthly spot} other {# founding monthly spots}} left. Subscribe monthly to claim {price} until the first {capacity} paid monthly members are gone.",
                  {
                      remaining: availability.remaining,
                      price: formatCatalogPrice(
                          foundingMonthly,
                          i18n("/month"),
                      ),
                      capacity: String(availability.capacity),
                  },
              )
            : standardMonthly
              ? i18n(
                    " The founding monthly spots are gone. New monthly subscriptions are {price}.",
                    {
                        price: formatCatalogPrice(
                            standardMonthly,
                            i18n("/month"),
                        ),
                    },
                )
              : "";
    const tiers: Tier[] = [
        {
            name: i18n("Self-host"),
            price: i18n("Free"),
            priceSuffix: i18n("forever"),
            tagline: i18n("Your machine, your data, your rules."),
            pill: { label: "AGPL-3.0", tone: "muted" },
            features: [
                i18n("Unlimited recordings and storage"),
                i18n("Runs on your laptop, NAS, or VPS via Docker"),
                i18n(
                    "Plug in OpenAI, Groq, Ollama, or transcribe free in your browser",
                ),
                i18n(
                    "Store locally, or push to Cloudflare R2, Backblaze B2, or AWS S3",
                ),
                i18n("Every feature, no gates"),
            ],
            cta: { label: i18n("Deploy with Docker"), href: "/install" },
            emphasis: false,
            note: i18n(
                "Want Riffado free? This is how. Bring your own server, AGPL source, no strings.",
            ),
        },
        {
            name: "Hosted Pro",
            price: headlinePrice ?? i18n("Unavailable"),
            compareAtPrice,
            priceSuffix: headlinePrice ? i18n("/ month") : "",
            tagline: i18n("Hosted, with the rough edges paid for."),
            pill: { label: i18n("14-day free trial"), tone: "primary" },
            features: [
                i18n("50 GB encrypted storage"),
                i18n("15 hours of included Mynah transcription per month"),
                i18n("Unlimited devices, background sync"),
                i18n("Off-site encrypted backups (coming soon)"),
                i18n("Plug in OpenAI, Groq, Ollama, or use ours"),
                i18n("Export everything any time: JSON, TXT, SRT, VTT"),
                i18n("Email support from the people who build it"),
            ],
            cta: {
                label: i18n("Start 14-day trial"),
                href: "/register",
            },
            emphasis: true,
            note: i18n("No card required to start.{details}", {
                details: `${foundingNote}${annualNote}`,
            }),
        },
    ];
    return (
        <section id="pricing" className="py-24 md:py-32">
            <div className="container mx-auto px-4">
                <div className="mx-auto max-w-5xl">
                    <div className="max-w-2xl mb-12 md:mb-16">
                        <p className="text-sm font-mono text-muted-foreground uppercase tracking-wider mb-4">
                            {i18n("Pricing")}
                        </p>
                        <h2 className="text-3xl md:text-4xl font-semibold tracking-tight mb-4 text-balance">
                            {i18n("Two ways to run it. Same source.")}
                        </h2>
                        <p className="text-muted-foreground text-lg leading-relaxed text-pretty">
                            {headlinePrice
                                ? i18n(
                                      "Pay us {price} a month and we run the server. ",
                                      { price: headlinePrice },
                                  )
                                : i18n(
                                      "Hosted billing is not configured on this instance. ",
                                  )}{" "}
                            {i18n(
                                "Or run it yourself for free. Same code, same features, every export round-trips.",
                            )}
                        </p>
                    </div>

                    {/*
                     * Subgrid on each card so header / features / CTA /
                     * note rows line up across both tiers regardless of
                     * how tall any individual section is.
                     */}
                    <div className="grid grid-cols-1 md:grid-cols-2 md:grid-rows-[auto_1fr_auto_auto] gap-4 md:gap-6">
                        {tiers.map((tier) => (
                            <TierCard key={tier.name} tier={tier} />
                        ))}
                    </div>

                    <p className="mt-8 text-xs text-muted-foreground/80 leading-relaxed text-pretty max-w-3xl">
                        {i18n(
                            "Hosted runs the exact AGPL-3.0 source you can self-host with no hidden fork and no proprietary add-ons.",
                        )}{" "}
                        <Link
                            href="https://github.com/riffado/riffado"
                            className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground transition-colors"
                        >
                            {i18n("Read the source")}
                        </Link>{" "}
                        {i18n(
                            ". You can move between Hosted and Self-host at any time using full-archive export.",
                        )}
                    </p>
                </div>
            </div>
        </section>
    );
}

function TierCard({ tier }: { tier: Tier }) {
    return (
        <div
            className={`relative rounded-2xl border p-6 md:p-7 md:grid md:grid-rows-subgrid md:row-span-4 flex flex-col gap-6 ${
                tier.emphasis
                    ? "border-primary/40 bg-card shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_18%,transparent)_inset]"
                    : "border-border bg-card/50"
            }`}
        >
            <div>
                <div className="flex items-center justify-between gap-3 mb-4">
                    <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                        {tier.name}
                    </div>
                    {tier.pill ? <Pill {...tier.pill} /> : null}
                </div>
                <div className="flex items-baseline gap-2 mb-2">
                    <span className="text-4xl md:text-5xl font-semibold tracking-tight tabular-nums leading-none">
                        {tier.price}
                    </span>
                    {tier.compareAtPrice ? (
                        <span className="text-xl text-muted-foreground/70 line-through tabular-nums">
                            {tier.compareAtPrice}
                        </span>
                    ) : null}
                    <span className="text-sm text-muted-foreground tabular-nums">
                        {tier.priceSuffix}
                    </span>
                </div>
                <p className="text-sm text-muted-foreground leading-snug">
                    {tier.tagline}
                </p>
            </div>

            <ul className="space-y-3">
                {tier.features.map((f) => (
                    <li
                        key={f}
                        className="flex items-start gap-2.5 text-sm leading-snug"
                    >
                        <Check
                            className={`size-4 mt-0.5 shrink-0 ${
                                tier.emphasis
                                    ? "text-primary"
                                    : "text-muted-foreground"
                            }`}
                            aria-hidden
                        />
                        <span>{f}</span>
                    </li>
                ))}
            </ul>

            <MetalButton
                asChild
                size="lg"
                className={`w-full ${
                    tier.emphasis
                        ? "bg-primary text-primary-foreground hover:bg-primary/90 border-primary/50"
                        : "bg-background/50"
                }`}
            >
                <Link href={tier.cta.href}>{tier.cta.label}</Link>
            </MetalButton>

            {tier.note ? (
                <p className="text-xs text-muted-foreground/70 leading-relaxed text-pretty">
                    {tier.note}
                </p>
            ) : null}
        </div>
    );
}

function Pill({ label, tone }: { label: string; tone: "muted" | "primary" }) {
    return (
        <span
            className={`text-[10px] font-mono uppercase tracking-wider rounded px-1.5 py-0.5 border ${
                tone === "primary"
                    ? "border-primary/40 text-primary bg-primary/5"
                    : "border-border/60 text-muted-foreground"
            }`}
        >
            {label}
        </span>
    );
}
