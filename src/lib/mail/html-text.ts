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

/**
 * Whether an opening tag starts a quoted part. Every client wraps the
 * quoted message itself in a `blockquote` (Gmail's `gmail_quote`, Apple
 * Mail's and Thunderbird's `type="cite"`); the containers around it hold
 * the reply header, which the segmenter reads as text, and Outlook's and
 * Gmail's forwards carry no quote markup at all.
 */
function opensQuote(tag: Tag): boolean {
    return tag.name === "blockquote";
}

/**
 * The text of `html` as a browser would lay it out in lines: a block
 * boundary breaks a line that has text, a `<br>` breaks one always (so an
 * empty `<div><br></div>` is an empty line), a paragraph is followed by a
 * blank line. Quoted parts sit between marker lines.
 */
export function htmlToText(html: string): string {
    const out: string[] = [];
    const stack: { name: string; quote: boolean }[] = [];
    let skipping: string | null = null;
    let quoteDepth = 0;
    let lineHasText = false;
    const breakLine = () => {
        if (lineHasText) out.push("\n");
        lineHasText = false;
    };
    const marker = (value: string) => {
        breakLine();
        out.push(`${value}\n`);
    };
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
            const selfClosing = /\/\s*>$/.test(token);
            if (!tag.closing && SKIPPED_TAGS.has(tag.name)) {
                if (!selfClosing) skipping = tag.name;
                continue;
            }
            if (tag.name === "br") {
                out.push("\n");
                lineHasText = false;
                continue;
            }
            if (!tag.closing) {
                const quote = opensQuote(tag);
                if (quote) {
                    quoteDepth++;
                    marker(QUOTE_OPEN);
                } else if (tag.name === "p") {
                    if (lineHasText) out.push("\n\n");
                    lineHasText = false;
                } else if (BLOCK_TAGS.has(tag.name)) {
                    breakLine();
                } else if (tag.name === "td" || tag.name === "th") {
                    if (lineHasText) out.push(" ");
                }
                if (!selfClosing && tag.name !== "hr") {
                    stack.push({ name: tag.name, quote });
                }
                continue;
            }
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i]?.name !== tag.name) continue;
                for (const closed of stack.splice(i)) {
                    if (closed.quote) {
                        quoteDepth--;
                        marker(QUOTE_CLOSE);
                    }
                }
                break;
            }
            if (tag.name === "p") {
                if (lineHasText) out.push("\n\n");
                lineHasText = false;
            } else if (BLOCK_TAGS.has(tag.name)) {
                breakLine();
            }
            continue;
        }
        if (skipping) continue;
        const text = decodeEntities(token.replace(/\s+/g, " "));
        if (!text.trim()) {
            if (lineHasText) out.push(" ");
            continue;
        }
        out.push(lineHasText ? text : text.replace(/^\s+/, ""));
        lineHasText = true;
    }
    while (quoteDepth-- > 0) marker(QUOTE_CLOSE);
    return out
        .join("")
        .split("\n")
        .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
