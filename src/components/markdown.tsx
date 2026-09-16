"use client";

import Link from "next/link";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    canonicalizeSummarySpeakerReferences,
    offsetSpeakerLabel,
    resolveSpeakerAttribution,
    type SpeakerAttributions,
    speakerAnchorId,
    speakerLabelFromSummaryHref,
} from "@/lib/knowledge/speaker-references";
import { cn } from "@/lib/utils";

const blockComponents: Components = {
    h1: ({ children }) => (
        <h3 className="text-base font-semibold mt-4 first:mt-0 mb-2">
            {children}
        </h3>
    ),
    h2: ({ children }) => (
        <h4 className="text-sm font-semibold mt-4 first:mt-0 mb-2">
            {children}
        </h4>
    ),
    // `###` is the level the summary prompts ask for, so it has to read as a
    // section heading rather than as the weakest one available.
    h3: ({ children }) => (
        <h5 className="text-sm font-semibold mt-4 first:mt-0 mb-2">
            {children}
        </h5>
    ),
    h4: ({ children }) => (
        <h6 className="text-sm font-medium mt-3 first:mt-0 mb-1">{children}</h6>
    ),
    h5: ({ children }) => (
        <h6 className="text-sm font-medium mt-3 first:mt-0 mb-1">{children}</h6>
    ),
    h6: ({ children }) => (
        <h6 className="text-sm font-medium mt-3 first:mt-0 mb-1">{children}</h6>
    ),
    p: ({ children }) => (
        <p className="leading-relaxed mb-3 last:mb-0">{children}</p>
    ),
    ul: ({ children }) => (
        <ul className="list-disc pl-5 mb-3 last:mb-0 space-y-1">{children}</ul>
    ),
    ol: ({ children }) => (
        <ol className="list-decimal pl-5 mb-3 last:mb-0 space-y-1">
            {children}
        </ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-primary/40 pl-3 italic text-muted-foreground mb-3 last:mb-0">
            {children}
        </blockquote>
    ),
    a: ({ href, children }) => (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:no-underline break-words"
        >
            {children}
        </a>
    ),
    code: ({ className, children }) => {
        const isBlock = Boolean(className?.startsWith("language-"));
        if (isBlock) {
            return <code className="font-mono text-xs block">{children}</code>;
        }
        return (
            <code className="font-mono text-[0.85em] bg-muted-foreground/15 rounded px-1 py-0.5">
                {children}
            </code>
        );
    },
    pre: ({ children }) => (
        <pre className="bg-muted-foreground/10 rounded-md p-3 mb-3 last:mb-0 overflow-x-auto">
            {children}
        </pre>
    ),
    table: ({ children }) => (
        <div className="overflow-x-auto mb-3 last:mb-0">
            <table className="w-full text-left border-collapse">
                {children}
            </table>
        </div>
    ),
    th: ({ children }) => (
        <th className="border-b px-2 py-1 font-medium align-top">{children}</th>
    ),
    td: ({ children }) => (
        <td className="border-b px-2 py-1 align-top">{children}</td>
    ),
    hr: () => <hr className="my-4 border-t" />,
    img: ({ alt }) => <span className="text-muted-foreground">{alt}</span>,
};

/**
 * Inline variant: no paragraph wrapper, no block spacing. Used where the
 * surrounding element already owns the layout, such as a single key point
 * inside a flex row.
 */
const inlineComponents: Components = {
    ...blockComponents,
    p: ({ children }) => <>{children}</>,
    ul: ({ children }) => <>{children}</>,
    ol: ({ children }) => <>{children}</>,
    li: ({ children }) => <>{children}</>,
};

export interface MarkdownProps {
    children: string;
    /** Render without block wrappers, for text inside an existing row. */
    inline?: boolean;
    className?: string;
    /** Confirmed names used to project stable summary speaker placeholders. */
    speakerAttributions?: SpeakerAttributions;
    /** Numeric correction for a summary that used one-based speaker labels. */
    speakerNumberOffset?: number;
}

/**
 * Render model-authored Markdown.
 *
 * Raw HTML is dropped rather than parsed: this text comes back from a
 * language model, and there is no case where a summary needs to inject
 * markup. `react-markdown` builds React elements, so nothing here reaches
 * `dangerouslySetInnerHTML`.
 */
export function Markdown({
    children,
    inline,
    className,
    speakerAttributions,
    speakerNumberOffset = 0,
}: MarkdownProps) {
    const Wrapper = inline ? "span" : "div";
    const components: Components = {
        ...(inline ? inlineComponents : blockComponents),
        a: ({ href, children: linkChildren }) => {
            const speaker = speakerLabelFromSummaryHref(href);
            const projectedSpeaker = speaker
                ? offsetSpeakerLabel(speaker, speakerNumberOffset)
                : null;
            const attribution = projectedSpeaker
                ? resolveSpeakerAttribution(
                      speakerAttributions,
                      projectedSpeaker,
                  )
                : undefined;
            if (attribution) {
                return (
                    <Link
                        href={`/people/${attribution.personId}`}
                        className="text-primary underline underline-offset-2 hover:no-underline"
                    >
                        {attribution.name}
                    </Link>
                );
            }
            if (href?.startsWith("#")) {
                const projectedAnchor = projectedSpeaker
                    ? speakerAnchorId(projectedSpeaker)
                    : null;
                return (
                    <a
                        href={projectedAnchor ? `#${projectedAnchor}` : href}
                        className="text-primary underline underline-offset-2 hover:no-underline"
                    >
                        {projectedAnchor
                            ? `Speaker ${projectedAnchor.slice("speaker-".length)}`
                            : linkChildren}
                    </a>
                );
            }
            return (
                <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2 hover:no-underline break-words"
                >
                    {linkChildren}
                </a>
            );
        },
    };
    return (
        <Wrapper className={cn(inline && "min-w-0", className)}>
            <ReactMarkdown
                skipHtml
                remarkPlugins={[remarkGfm]}
                components={components}
            >
                {canonicalizeSummarySpeakerReferences(children)}
            </ReactMarkdown>
        </Wrapper>
    );
}
