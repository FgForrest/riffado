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

/** A secret address with its token hidden: `jan.•••@klepna.example`. */
function masked(localPart: string): string {
    const dot = localPart.lastIndexOf(".");
    return `${dot > 0 ? localPart.slice(0, dot) : ""}.•••@${mailDomain()}`;
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
