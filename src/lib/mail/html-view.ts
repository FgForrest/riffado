import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";

/** Inline images larger than this stay out (one each, and in total). */
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 8 * 1024 * 1024;

const CSP =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'";

/** A CSS value without anything that fetches: no url(), image-set(), @import. */
const SAFE_CSS_VALUE =
    /^(?!.*(url\s*\(|image-set|expression\s*\(|@import|\\)).*$/i;

const STYLE_PROPERTIES = [
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "line-height",
    "text-align",
    "text-decoration",
    "text-transform",
    "vertical-align",
    "white-space",
    "width",
    "max-width",
    "height",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border-collapse",
    "border-color",
    "border-radius",
    "border-spacing",
    "border-style",
    "border-width",
    "display",
    "list-style-type",
];

function sanitize(html: string): string {
    return sanitizeHtml(html, {
        allowedTags: [
            ...sanitizeHtml.defaults.allowedTags.filter(
                (tag) => tag !== "style",
            ),
            "img",
            "font",
            "center",
            "span",
            "u",
            "s",
            "small",
            "sub",
            "sup",
        ],
        disallowedTagsMode: "discard",
        allowedAttributes: {
            "*": [
                "style",
                "align",
                "valign",
                "width",
                "height",
                "bgcolor",
                "dir",
                "lang",
                "title",
            ],
            a: ["href", "name"],
            img: ["src", "alt", "width", "height"],
            font: ["face", "size", "color"],
            td: ["colspan", "rowspan"],
            th: ["colspan", "rowspan"],
            table: ["border", "cellpadding", "cellspacing"],
            ol: ["start", "type"],
        },
        allowedSchemes: ["http", "https", "mailto"],
        allowedSchemesByTag: { img: ["data"] },
        allowedSchemesAppliedToAttributes: ["href", "src"],
        allowProtocolRelative: false,
        allowedStyles: {
            "*": Object.fromEntries(
                STYLE_PROPERTIES.map((property) => [
                    property,
                    [SAFE_CSS_VALUE],
                ]),
            ),
        },
        transformTags: {
            a: (_tagName, attribs) => ({
                tagName: "a",
                attribs: {
                    ...attribs,
                    rel: "noopener noreferrer nofollow",
                },
            }),
        },
    });
}

/** `cid:` references of `html` replaced by data URIs of inline images. */
function inlineImages(
    html: string,
    images: ReadonlyMap<string, string>,
): string {
    return html.replace(
        /(["'])cid:([^"']+)\1/gi,
        (_match, quote: string, cid: string) => {
            const uri = images.get(cid.trim().toLowerCase());
            return uri ? `${quote}${uri}${quote}` : `${quote}${quote}`;
        },
    );
}

/**
 * A mail's HTML as a self-contained document for an empty-`sandbox`
 * iframe's `srcdoc`: sanitized, styles without anything that fetches,
 * inline images as data URIs, and a CSP that allows nothing else. Null
 * when the mail has no HTML.
 */
export async function renderMailHtml(raw: Buffer): Promise<string | null> {
    const mail = await simpleParser(raw, {
        skipHtmlToText: true,
        skipTextToHtml: true,
        skipImageLinks: true,
        keepCidLinks: true,
    });
    if (!mail.html) return null;
    const images = new Map<string, string>();
    let total = 0;
    for (const attachment of mail.attachments) {
        const cid = (attachment.contentId ?? attachment.cid ?? "")
            .replace(/^<|>$/g, "")
            .trim()
            .toLowerCase();
        if (!cid || !attachment.contentType.startsWith("image/")) continue;
        if (
            attachment.size > MAX_INLINE_IMAGE_BYTES ||
            total + attachment.size > MAX_INLINE_TOTAL_BYTES
        ) {
            continue;
        }
        total += attachment.size;
        images.set(
            cid,
            `data:${attachment.contentType};base64,${attachment.content.toString("base64")}`,
        );
    }
    const body = sanitize(inlineImages(mail.html, images));
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;margin:0;padding:12px;color:#111;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}blockquote{margin:0 0 0 .5em;padding-left:.75em;border-left:2px solid #ccc;color:#555}</style></head><body>${body}</body></html>`;
}
