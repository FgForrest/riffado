import type { DocsLayoutProps } from "fumadocs-ui/layouts/docs";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function createBaseOptions(docsTitle: string): BaseLayoutProps {
    return {
        nav: {
            title: docsTitle,
            url: "/docs",
        },
        githubUrl: "https://github.com/riffado/riffado",
    };
}

export function createDocsTabs(
    titles: readonly [string, string, string],
): NonNullable<DocsLayoutProps["tabs"]> {
    return [
        { title: titles[0], url: "/docs/guides" },
        { title: titles[1], url: "/docs/self-hosting" },
        { title: titles[2], url: "/docs/reference" },
    ];
}
