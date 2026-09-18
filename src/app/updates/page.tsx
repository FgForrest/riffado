import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { getExtracted } from "next-intl/server";
import { LandingNav } from "@/components/landing/landing-nav";
import { LandingFooter } from "@/components/landing-footer";
import { NewsletterForm } from "@/components/marketing/newsletter-form";
import { marketingMetadata } from "@/lib/seo/marketing-metadata";

export async function generateMetadata(): Promise<Metadata> {
    const i18n = await getExtracted();
    return marketingMetadata({
        title: i18n("Riffado product updates"),
        description: i18n(
            "Occasional emails about new features, releases, and improvements to Riffado. A few times a year at most.",
        ),
        path: "/updates",
    });
}

export default function UpdatesPage() {
    const i18n = useExtracted();
    return (
        <div className="min-h-screen flex flex-col bg-background text-foreground">
            <LandingNav />

            <main className="flex-1">
                <article className="container mx-auto px-4 max-w-2xl pt-16 md:pt-24 pb-24 md:pb-32">
                    <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-3">
                        {i18n("Newsletter")}
                    </p>
                    <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-balance">
                        {i18n("Riffado product updates")}
                    </h1>
                    <p className="mt-4 text-lg text-muted-foreground leading-relaxed text-pretty">
                        {i18n(
                            "New features, release notes, and the occasional behind-the-scenes post about what we're building. A few times a year at most, never more than once a month.",
                        )}
                    </p>

                    <div className="mt-10">
                        <NewsletterForm source="landing" />
                    </div>

                    <section className="mt-16 space-y-3">
                        <h2 className="text-lg font-semibold tracking-tight">
                            {i18n("What you'll get")}
                        </h2>
                        <ul className="text-muted-foreground leading-relaxed space-y-2 list-disc pl-5">
                            <li>
                                {i18n(
                                    "A short note when we ship a meaningful new feature (better transcription, new device support, storage adapters, etc.).",
                                )}
                            </li>
                            <li>
                                {i18n(
                                    "Self-host upgrade reminders when a release includes a migration or env-var change.",
                                )}
                            </li>
                            <li>
                                {i18n(
                                    "The occasional behind-the-scenes post about what we're working on.",
                                )}
                            </li>
                        </ul>
                    </section>

                    <section className="mt-10 space-y-3">
                        <h2 className="text-lg font-semibold tracking-tight">
                            {i18n("What you won't get")}
                        </h2>
                        <ul className="text-muted-foreground leading-relaxed space-y-2 list-disc pl-5">
                            <li>{i18n("Daily / weekly emails.")}</li>
                            <li>
                                {i18n(
                                    'Drip sequences, sales funnels, "just checking in" nudges.',
                                )}
                            </li>
                            <li>
                                {i18n(
                                    "Anyone else's mail. We don't share or sell the list.",
                                )}
                            </li>
                        </ul>
                    </section>

                    <p className="mt-16 text-sm">
                        <Link
                            href="/"
                            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
                        >
                            <ArrowLeft className="size-3.5" aria-hidden />{" "}
                            {i18n("Back to riffado.com")}
                        </Link>
                    </p>
                </article>
            </main>

            <LandingFooter />
        </div>
    );
}
