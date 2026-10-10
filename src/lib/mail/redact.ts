import type { ItemContent } from "@/lib/content/types";
import { resolveLocalPart } from "@/lib/mail/addresses";
import { mailDomain } from "@/lib/mail/config";

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addressPattern(): RegExp {
    return new RegExp(
        `([a-z0-9][a-z0-9.+-]*)@${escapeRegExp(mailDomain())}`,
        "gi",
    );
}

/**
 * A secret address with its token hidden, as long as it was
 * (`jan.••••••••••@klepna.example`), so places in a text stay where they
 * were.
 */
function masked(localPart: string): string {
    const dot = localPart.lastIndexOf(".");
    const kept = dot > 0 ? localPart.slice(0, dot + 1) : "";
    return `${kept}${"•".repeat(localPart.length - kept.length)}@${mailDomain()}`;
}

/**
 * A function hiding the token of every secret address on the mail domain
 * that `texts` mention: whoever learns one can send mail into its owner's
 * pile, so only the owner sees them whole.
 */
export async function secretAddressMasker(
    texts: readonly string[],
): Promise<(text: string) => string> {
    const localParts = new Set<string>();
    for (const text of texts) {
        for (const match of text.matchAll(addressPattern())) {
            if (match[1]) localParts.add(match[1].toLowerCase());
        }
    }
    const secrets = new Set<string>();
    for (const localPart of localParts) {
        if ((await resolveLocalPart(localPart))?.kind === "secret") {
            secrets.add(localPart);
        }
    }
    if (secrets.size === 0) return (text) => text;
    return (text) =>
        text.replace(addressPattern(), (whole, localPart: string) =>
            secrets.has(localPart.toLowerCase()) ? masked(localPart) : whole,
        );
}

/**
 * A mail's content with every secret address masked, for a model to read:
 * a token a summary repeated would reach whoever reads the summary. Same
 * lengths, so a quote the model gives back is found at the same place.
 */
export async function maskedContentForModel<
    T extends Pick<ItemContent, "segments">,
>(content: T): Promise<T> {
    const mask = await secretAddressMasker(
        content.segments.map((segment) => segment.text),
    );
    return {
        ...content,
        segments: content.segments.map((segment) => ({
            ...segment,
            text: mask(segment.text),
        })),
    };
}
