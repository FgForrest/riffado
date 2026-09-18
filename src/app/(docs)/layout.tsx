import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { getExtracted, getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { createBaseOptions, createDocsTabs } from "@/app/layout.config";
import { source } from "@/lib/source";
import "fumadocs-ui/style.css";
import "./docs.css";

export default async function DocsRootLayout({
    children,
}: {
    children: ReactNode;
}) {
    const [i18n, locale] = await Promise.all([getExtracted(), getLocale()]);
    const baseOptions = createBaseOptions(i18n("Riffado Docs"));
    const docsTabs = createDocsTabs([
        i18n("Guides"),
        i18n("Self Hosting"),
        i18n("Reference"),
    ]);

    // theme.enabled: false so Fumadocs doesn't double-mount next-themes.
    return (
        <RootProvider
            theme={{ enabled: false }}
            i18n={{
                locale,
                translations: {
                    search: i18n("Search"),
                    searchNoResult: i18n("No results found"),
                    toc: i18n("On this page"),
                    tocNoHeadings: i18n("No headings"),
                    lastUpdate: i18n("Last updated"),
                    chooseLanguage: i18n("Choose language"),
                    nextPage: i18n("Next page"),
                    previousPage: i18n("Previous page"),
                    chooseTheme: i18n("Choose theme"),
                    editOnGithub: i18n("Edit on GitHub"),
                },
            }}
        >
            <DocsLayout tree={source.pageTree} tabs={docsTabs} {...baseOptions}>
                {children}
            </DocsLayout>
        </RootProvider>
    );
}
