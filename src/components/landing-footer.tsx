import Link from "next/link";
import { useExtracted } from "next-intl";
import { Github, X } from "@/components/icons/icons";
import { LogoWordmark } from "@/components/icons/logo";
import { NewsletterForm } from "@/components/marketing/newsletter-form";

/**
 * Marketing footer for hosted public surfaces. Currently mounted on:
 *   - `/`                           (`src/app/page.tsx`)
 *   - `/install` (hosted branch)    (`src/app/install/page.tsx`)
 *   - `/privacy`, `/terms`          (`src/app/(legal)/layout.tsx`)
 *
 * Intentionally not used by `src/app/(app)/layout.tsx` -- signed-in
 * users get the minimal `Footer` (AppFooter) from `./footer.tsx`
 * instead. Splitting them keeps app chrome from inheriting marketing-
 * sitemap weight, and keeps marketing free to grow columns without
 * bloating every workstation screen.
 *
 * Every call site that mounts this component is hosted-only -- either
 * by virtue of `src/app/page.tsx` redirecting to `/login` when
 * `IS_HOSTED` is unset, the `(legal)` layout calling `notFound()` on
 * self-host, or `/install` branching on `env.IS_HOSTED` to render
 * `Footer` instead. The component itself therefore never needs to
 * internally branch on hosted/self-host; new call sites must keep
 * this invariant.
 */

type FooterLink = {
    label: string;
    href: string;
    external?: boolean;
};

type FooterColumn = {
    title: string;
    links: FooterLink[];
};

function FooterLinkItem({ label, href, external }: FooterLink) {
    const externalProps = external
        ? { target: "_blank", rel: "noopener noreferrer" as const }
        : {};
    return (
        <li>
            <Link
                href={href}
                {...externalProps}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
                {label}
            </Link>
        </li>
    );
}

export function LandingFooter() {
    const i18n = useExtracted();
    const currentYear = new Date().getFullYear();
    const columns: FooterColumn[] = [
        {
            title: i18n("Product"),
            links: [
                { label: i18n("Features"), href: "/#features" },
                { label: i18n("Pricing"), href: "/#pricing" },
                { label: i18n("Self-host"), href: "/#deploy" },
                {
                    label: i18n("For Professionals"),
                    href: "/for-professionals",
                },
                { label: i18n("Changelog"), href: "/changelog" },
                {
                    label: i18n("Roadmap"),
                    href: "https://github.com/riffado/riffado/issues",
                    external: true,
                },
            ],
        },
        {
            title: i18n("Community"),
            links: [
                { label: i18n("Documentation"), href: "/docs" },
                {
                    label: i18n("Discussions"),
                    href: "https://github.com/riffado/riffado/discussions",
                    external: true,
                },
                {
                    label: i18n("Code of Conduct"),
                    href: "https://github.com/riffado/riffado/blob/main/CODE_OF_CONDUCT.md",
                    external: true,
                },
                {
                    label: i18n("Contact"),
                    href: "mailto:support@riffado.com",
                },
            ],
        },
        {
            title: i18n("Legal"),
            links: [
                { label: i18n("Privacy"), href: "/privacy" },
                { label: i18n("Terms"), href: "/terms" },
                {
                    label: i18n("Security"),
                    href: "https://github.com/riffado/riffado/blob/main/SECURITY.md",
                    external: true,
                },
                {
                    label: i18n("Security disclosure"),
                    href: "mailto:security@riffado.com",
                },
            ],
        },
    ];

    return (
        <footer className="border-t border-border/40 bg-background">
            <div className="container mx-auto px-4 py-16 md:py-20 max-w-7xl">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-8 md:gap-12">
                    {/* Brand block spans 2 cols on desktop so the three
                        sitemap columns sit cleanly to the right. */}
                    <div className="col-span-2 flex flex-col gap-4">
                        <Link
                            href="/"
                            className="flex items-center hover:opacity-80 transition-opacity w-fit"
                            aria-label={i18n("Riffado")}
                        >
                            <LogoWordmark className="h-7 w-auto" />
                        </Link>
                        {/*<p className="text-sm text-muted-foreground leading-relaxed max-w-xs">
                            Open-source transcription for the voice recorder you
                            already own. Your recordings, your transcripts,
                            yours to keep.
                        </p>*/}
                        <div className="flex items-center gap-3 mt-1">
                            <Link
                                href="https://github.com/riffado/riffado"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-muted-foreground hover:text-foreground transition-colors"
                                aria-label={i18n("Riffado on GitHub")}
                            >
                                <Github className="size-5" />
                            </Link>
                            <Link
                                href="https://x.com/riffadohq"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-muted-foreground hover:text-foreground transition-colors"
                                aria-label={i18n("Riffado on X")}
                            >
                                <X className="size-[18px]" />
                            </Link>
                        </div>

                        <div>
                            <h3 className="text-xs font-semibold font-mono uppercase tracking-wider text-foreground/80">
                                {i18n("Product updates")}
                            </h3>
                            <p className="mt-2 text-sm text-muted-foreground leading-relaxed max-w-sm">
                                {i18n(
                                    "Occasional emails when we ship something worth telling you about.",
                                )}
                            </p>
                            <div className="mt-4 max-w-md">
                                <NewsletterForm source="landing" />
                            </div>
                            <Link
                                href="/updates"
                                className="mt-3 inline-block text-sm text-muted-foreground hover:text-foreground transition-colors"
                            >
                                {i18n("What you'll get →")}
                            </Link>
                        </div>
                    </div>

                    {columns.map((col) => (
                        <div key={col.title} className="flex flex-col gap-3">
                            <h3 className="text-xs font-semibold font-mono uppercase tracking-wider text-foreground/80">
                                {col.title}
                            </h3>
                            <ul className="flex flex-col gap-2">
                                {col.links.map((link) => (
                                    <FooterLinkItem
                                        key={link.label}
                                        {...link}
                                    />
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>

                {/* Honesty rail + copyright share one top border. The
                    honesty rail is the trust signal Riffado's Slice 2
                    audience (lawyers/journalists/regulated work)
                    actually responds to -- mirrors the FAQ's HIPAA
                    answer. Previously these sat under two adjacent
                    rules ~30px apart; merged into one block to quiet
                    the bottom of the page. */}
                <div className="mt-12 pt-6 border-t border-border/40 flex flex-col gap-6">
                    <p className="text-xs text-muted-foreground/80 leading-relaxed max-w-2xl">
                        {i18n(
                            "Riffado is not HIPAA or SOC 2 certified. For regulated work, self-host and plug in an AI provider that signs a BAA you've reviewed, or run a local model that never leaves your machine.",
                        )}
                    </p>
                    <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <p className="text-xs text-muted-foreground font-mono">
                            © {currentYear} {i18n("Riffado. Licensed under")}{" "}
                            <Link
                                href="https://www.gnu.org/licenses/agpl-3.0.html"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-foreground/80 hover:text-foreground transition-colors underline decoration-dotted underline-offset-2"
                            >
                                {i18n("AGPL-3.0")}
                            </Link>
                            .
                        </p>
                        <p className="text-xs text-muted-foreground/70 font-mono">
                            {i18n("Built in the open on")}{" "}
                            <Link
                                href="https://github.com/riffado/riffado"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-foreground transition-colors underline decoration-dotted underline-offset-2"
                            >
                                {i18n("GitHub")}
                            </Link>
                        </p>
                    </div>
                </div>
            </div>
        </footer>
    );
}
