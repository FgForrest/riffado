/**
 * A mail's HTML as text, for reading and segmenting, with the places a
 * client marked as quoted kept as markers: `QUOTE_OPEN` and `QUOTE_CLOSE`
 * lines around each quoted part (Gmail's `gmail_quote`, a `blockquote`,
 * Outlook's reply divider). Nothing here is ever rendered as HTML.
 */

export const QUOTE_OPEN = "\u0001quote-open\u0001";
export const QUOTE_CLOSE = "\u0001quote-close\u0001";

const BLOCK_TAGS = new Set([
    "address",
    "article",
    "aside",
    "dd",
    "div",
    "dl",
    "dt",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tr",
    "ul",
]);

const SKIPPED_TAGS = new Set(["head", "script", "style", "title", "template"]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    laquo: "«",
    raquo: "»",
    bdquo: "„",
    ldquo: "“",
    rdquo: "”",
    lsquo: "‘",
    rsquo: "’",
    copy: "©",
    reg: "®",
    euro: "€",
};

/** Decodes the character references of `text`. */
export function decodeEntities(text: string): string {
    return text.replace(
        /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
        (match, ref: string) => {
            if (ref[0] === "#") {
                const code =
                    ref[1] === "x" || ref[1] === "X"
                        ? Number.parseInt(ref.slice(2), 16)
                        : Number.parseInt(ref.slice(1), 10);
                return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                    ? String.fromCodePoint(code)
                    : match;
            }
            return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
        },
    );
}

interface Tag {
    name: string;
    closing: boolean;
    attributes: string;
}

function parseTag(raw: string): Tag | null {
    const match = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)([\s\S]*?)\/?\s*>$/i.exec(
        raw,
    );
    if (!match) return null;
    return {
        name: (match[2] ?? "").toLowerCase(),
        closing: match[1] === "/",
        attributes: match[3] ?? "",
    };
}

/** Whether an opening tag starts a quoted part, by how clients mark one. */
function opensQuote(tag: Tag): boolean {
    if (tag.name === "blockquote") return true;
    if (tag.name !== "div") return false;
    const attributes = tag.attributes.toLowerCase();
    return (
        /class\s*=\s*["'][^"']*\bgmail_quote\b/.test(attributes) ||
        /id\s*=\s*["']?(appendonsend|divrplyfwdmsg|mail-editor-reference-message-container)\b/.test(
            attributes,
        ) ||
        /class\s*=\s*["'][^"']*\b(yahoo_quoted|moz-cite-prefix)\b/.test(
            attributes,
        )
    );
}

/**
 * The text of `html`, block elements on lines of their own, quoted parts
 * between markers. Gmail's attribution line (`gmail_attr`) stays inside the
 * quote it introduces, where the segmenter reads it.
 */
export function htmlToText(html: string): string {
    const out: string[] = [];
    // Per open element: whether it opened a quote.
    const stack: { name: string; quote: boolean }[] = [];
    let skipping: string | null = null;
    let quoteDepth = 0;
    const tokens = html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
    for (const token of tokens) {
        if (token.startsWith("<!--")) continue;
        if (token.startsWith("<")) {
            const tag = parseTag(token);
            if (!tag) continue;
            if (skipping) {
                if (tag.closing && tag.name === skipping) skipping = null;
                continue;
            }
            if (!tag.closing && SKIPPED_TAGS.has(tag.name)) {
                if (!/\/\s*>$/.test(token)) skipping = tag.name;
                continue;
            }
            if (tag.name === "br") {
                out.push("\n");
                continue;
            }
            if (!tag.closing) {
                const quote = opensQuote(tag);
                if (quote) {
                    quoteDepth++;
                    out.push(`\n${QUOTE_OPEN}\n`);
                } else if (BLOCK_TAGS.has(tag.name) || tag.name === "td") {
                    out.push(tag.name === "td" ? " " : "\n");
                }
                if (tag.name === "hr") out.push("\n");
                if (!/\/\s*>$/.test(token) && tag.name !== "hr") {
                    stack.push({ name: tag.name, quote });
                }
                continue;
            }
            // A closing tag closes the innermost open element of its name.
            for (let i = stack.length - 1; i >= 0; i--) {
                const open = stack[i];
                if (open?.name !== tag.name) continue;
                for (const closed of stack.splice(i)) {
                    if (closed.quote) {
                        quoteDepth--;
                        out.push(`\n${QUOTE_CLOSE}\n`);
                    }
                }
                break;
            }
            if (BLOCK_TAGS.has(tag.name)) out.push("\n");
            continue;
        }
        if (skipping) continue;
        out.push(decodeEntities(token.replace(/\s+/g, " ")));
    }
    while (quoteDepth-- > 0) out.push(`\n${QUOTE_CLOSE}\n`);
    return out
        .join("")
        .split("\n")
        .map((line) => line.replace(/[ \t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
