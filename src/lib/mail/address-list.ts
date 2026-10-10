/**
 * The mailboxes of an address header (From, To, Cc), RFC 5322 enough for
 * deciding who a message is from and to: quoted display names, comments,
 * angle addresses and groups. Encoded words in display names are left as
 * they are; the addresses are what matter here.
 */

export interface ParsedMailbox {
    /** Lowercase `local@domain`. */
    address: string;
    /** The display name, unquoted; empty when there is none. */
    name: string;
}

const ADDR_SPEC = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** Splits on top-level commas, outside quotes, comments and angle brackets. */
function topLevelParts(value: string, separators: string): string[] {
    const parts: string[] = [];
    let current = "";
    let depth = 0;
    let quoted = false;
    let angle = false;
    for (let i = 0; i < value.length; i++) {
        const char = value[i] ?? "";
        if (quoted) {
            current += char;
            if (char === "\\") {
                current += value[i + 1] ?? "";
                i++;
            } else if (char === '"') {
                quoted = false;
            }
            continue;
        }
        if (char === '"') quoted = true;
        else if (char === "(") depth++;
        else if (char === ")") depth = Math.max(0, depth - 1);
        else if (char === "<") angle = true;
        else if (char === ">") angle = false;
        else if (depth === 0 && !angle && separators.includes(char)) {
            parts.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter(Boolean);
}

function withoutComments(value: string): string {
    let out = "";
    let depth = 0;
    let quoted = false;
    for (let i = 0; i < value.length; i++) {
        const char = value[i] ?? "";
        if (quoted) {
            out += char;
            if (char === "\\") {
                out += value[i + 1] ?? "";
                i++;
            } else if (char === '"') quoted = false;
            continue;
        }
        if (depth === 0 && char === '"') {
            quoted = true;
            out += char;
        } else if (char === "(") depth++;
        else if (char === ")") depth = Math.max(0, depth - 1);
        else if (depth === 0) out += char;
    }
    return out;
}

function unquote(name: string): string {
    const trimmed = name.trim();
    if (
        trimmed.startsWith('"') &&
        trimmed.endsWith('"') &&
        trimmed.length >= 2
    ) {
        return trimmed.slice(1, -1).replace(/\\(.)/g, "$1").trim();
    }
    return trimmed;
}

function mailboxOf(part: string): ParsedMailbox | null {
    const cleaned = withoutComments(part).trim();
    const angle = /<([^<>]*)>\s*$/.exec(cleaned);
    if (angle) {
        const address = (angle[1] ?? "").trim().toLowerCase();
        if (!ADDR_SPEC.test(address)) return null;
        return { address, name: unquote(cleaned.slice(0, angle.index)) };
    }
    const address = cleaned.toLowerCase();
    return ADDR_SPEC.test(address) ? { address, name: "" } : null;
}

/** The mailboxes in an address header's value; groups are flattened. */
export function parseAddressList(value: string): ParsedMailbox[] {
    const unfolded = value.replace(/\r?\n[ \t]+/g, " ");
    const mailboxes: ParsedMailbox[] = [];
    for (const part of topLevelParts(unfolded, ",;")) {
        const group = /^[^"<>()]*:/.exec(part);
        const members = group
            ? topLevelParts(part.slice(group[0].length), ",;")
            : [part];
        for (const member of members) {
            const mailbox = mailboxOf(member);
            if (mailbox) mailboxes.push(mailbox);
        }
    }
    return mailboxes;
}

/**
 * The value of each header named `name` in a raw header block (`Name:
 * value` lines, folded), in order.
 */
export function headerValues(lines: readonly string[], name: string): string[] {
    const wanted = name.toLowerCase();
    const values: string[] = [];
    for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        if (line.slice(0, colon).trim().toLowerCase() !== wanted) continue;
        values.push(line.slice(colon + 1));
    }
    return values;
}
