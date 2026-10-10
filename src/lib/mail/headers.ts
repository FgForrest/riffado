/**
 * A raw message's header block, read without a MIME parser: enough to
 * count From headers, find DKIM-Signature headers and drop surplus ones
 * before verification. Lines are unfolded; names keep their case.
 */

export interface RawHeader {
    name: string;
    /** The value, unfolded, without the leading space. */
    value: string;
    /** The header exactly as it stood, folding and line ends included. */
    raw: string;
}

/**
 * Where the header block ends: just past the last header's line end, so
 * the rest starts with the blank line. -1 when there is no blank line.
 */
function headerEnd(raw: Buffer): number {
    const crlf = raw.indexOf("\r\n\r\n");
    const lf = raw.indexOf("\n\n");
    if (crlf < 0 && lf < 0) return -1;
    if (crlf >= 0 && (lf < 0 || crlf < lf)) return crlf + 2;
    return lf + 1;
}

/** The headers of a raw message, in order. */
export function readRawHeaders(raw: Buffer): RawHeader[] {
    const end = headerEnd(raw);
    const block = (end < 0 ? raw : raw.subarray(0, end)).toString("latin1");
    const headers: RawHeader[] = [];
    const lines = block.split(/(?<=\n)/);
    for (const line of lines) {
        const last = headers.at(-1);
        if (/^[ \t]/.test(line) && last) {
            last.raw += line;
            last.value += ` ${line.trim()}`;
            continue;
        }
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        headers.push({
            name: line.slice(0, colon).trim(),
            value: line.slice(colon + 1).trim(),
            raw: line,
        });
    }
    for (const header of headers) header.value = header.value.trim();
    return headers;
}

/** The values of every header named `name` (case-insensitive). */
export function headerValuesOf(
    headers: readonly RawHeader[],
    name: string,
): string[] {
    const wanted = name.toLowerCase();
    return headers
        .filter((header) => header.name.toLowerCase() === wanted)
        .map((header) => header.value);
}

/** A DKIM-Signature's tags (`d`, `s`, `t`, `h`, ...), lowercase names. */
export function dkimTags(value: string): Map<string, string> {
    const tags = new Map<string, string>();
    for (const part of value.split(";")) {
        const eq = part.indexOf("=");
        if (eq <= 0) continue;
        tags.set(
            part.slice(0, eq).trim().toLowerCase(),
            part.slice(eq + 1).replace(/\s+/g, ""),
        );
    }
    return tags;
}

/**
 * The raw message with only the DKIM-Signature headers `keep` selects:
 * a message carrying dozens of signatures costs one DNS lookup each.
 */
export function withDkimSignatures(
    raw: Buffer,
    keep: (header: RawHeader, index: number) => boolean,
): Buffer {
    const end = headerEnd(raw);
    if (end < 0) return raw;
    const headers = readRawHeaders(raw);
    let index = 0;
    const kept = headers.filter((header) => {
        if (header.name.toLowerCase() !== "dkim-signature") return true;
        return keep(header, index++);
    });
    if (kept.length === headers.length) return raw;
    const block = kept.map((header) => header.raw).join("");
    return Buffer.concat([Buffer.from(block, "latin1"), raw.subarray(end)]);
}
