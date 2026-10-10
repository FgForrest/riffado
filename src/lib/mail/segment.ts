/**
 * A mail's text as segments: its own body, its signature, every quoted or
 * forwarded message with its claimed author and date, their signatures,
 * and disclaimers. Deterministic and pure.
 *
 * Quotes are found from the HTML's markup first (`html-text.ts` keeps
 * Gmail's, Outlook's and Apple Mail's quote containers as markers), then
 * from text: `>` prefixes, reply headers ("On ... wrote:", "Dne ...
 * napsal(a):") and forwarded or original-message header blocks in English
 * and Czech. What does not parse stays in the enclosing segment.
 */

import type {
    ContentParticipant,
    ContentSegment,
    ParticipantRole,
    SegmentRole,
} from "@/lib/content/types";
import { type ParsedMailbox, parseAddressList } from "@/lib/mail/address-list";
import { htmlToText, QUOTE_CLOSE, QUOTE_OPEN } from "@/lib/mail/html-text";

/** Moves when segmentation changes: a re-parse writes a new revision. */
export const MAIL_PARSER_VERSION = 1;

/** A participant with what only mail has: address and authentication. */
export interface MailParticipant extends ContentParticipant {
    address: string | null;
    authenticated: boolean;
}

export interface SegmentedMail {
    participants: MailParticipant[];
    segments: ContentSegment[];
}

export interface SegmentInput {
    text: string | null;
    html: string | null;
    from: ParsedMailbox | null;
    sender?: ParsedMailbox | null;
    to?: readonly ParsedMailbox[];
    cc?: readonly ParsedMailbox[];
    replyTo?: readonly ParsedMailbox[];
    sentAt: Date | null;
    /** The From address was proven by a DKIM signature. */
    fromAuthenticated: boolean;
}

interface Line {
    depth: number;
    text: string;
}

interface Part {
    depth: number;
    author: ParsedMailbox | null;
    at: Date | null;
    lines: string[];
}

/** The text's lines with their quote depth, from markers and `>`. */
function quotedLines(text: string): Line[] {
    const lines: Line[] = [];
    let markerDepth = 0;
    for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
        if (raw.trim() === QUOTE_OPEN) {
            markerDepth++;
            continue;
        }
        if (raw.trim() === QUOTE_CLOSE) {
            markerDepth = Math.max(0, markerDepth - 1);
            continue;
        }
        const prefix = /^((?:\s*>)+)\s?/.exec(raw);
        const arrows = prefix ? (prefix[1]?.match(/>/g)?.length ?? 0) : 0;
        lines.push({
            depth: markerDepth + arrows,
            text: (prefix ? raw.slice(prefix[0].length) : raw).trimEnd(),
        });
    }
    return lines;
}

const CZECH_MONTHS: Readonly<Record<string, number>> = {
    led: 1,
    úno: 2,
    bře: 3,
    dub: 4,
    kvě: 5,
    čer: 6,
    čvc: 7,
    srp: 8,
    zář: 9,
    říj: 10,
    lis: 11,
    pro: 12,
};

/** A date as reply headers write it, or null. */
export function parseClaimedDate(text: string): Date | null {
    const numeric =
        /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})(?:[^\d]{1,6}(\d{1,2}):(\d{2}))?/.exec(
            text,
        );
    if (numeric) {
        const [, day, month, year, hour, minute] = numeric;
        const date = new Date(
            Date.UTC(
                Number(year),
                Number(month) - 1,
                Number(day),
                Number(hour ?? 0),
                Number(minute ?? 0),
            ),
        );
        return Number.isNaN(date.getTime()) ? null : date;
    }
    const czechMonth = /(\d{1,2})\.\s*([a-zá-ž]{3})[a-zá-ž]*\s+(\d{4})/i.exec(
        text,
    );
    if (czechMonth) {
        const month = CZECH_MONTHS[(czechMonth[2] ?? "").toLowerCase()];
        if (month) {
            return new Date(
                Date.UTC(
                    Number(czechMonth[3]),
                    month - 1,
                    Number(czechMonth[1]),
                ),
            );
        }
    }
    const cleaned = text
        .replace(/\b(at|um|v)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    const parsed = Date.parse(cleaned);
    return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** The mailbox a reply header names, by its address. */
function mailboxIn(text: string): ParsedMailbox | null {
    const angle = /([^<>"]*?)\s*<([^<>\s]+@[^<>\s]+)>/.exec(text);
    if (angle) {
        const address = (angle[2] ?? "").toLowerCase();
        const name = (angle[1] ?? "").replace(/^["'\s,]+|["'\s,]+$/g, "");
        return { address, name };
    }
    const bare = /([^\s<>"()[\],;:]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(text);
    if (bare) return { address: (bare[1] ?? "").toLowerCase(), name: "" };
    const [parsed] = parseAddressList(text);
    return parsed ?? null;
}

interface Attribution {
    author: ParsedMailbox | null;
    at: Date | null;
}

const WROTE_PATTERNS: readonly RegExp[] = [
    /^On (.+) wrote:\s*$/i,
    /^Dne (.+?)\s+(?:napsal\(a\)|napsala|napsal|odesílatel .+ napsal):?\s*$/i,
    /^(.+?)\s+odesílatel\s+(.+?)\s+napsal:?\s*$/i,
    /^Am (.+) schrieb .+:\s*$/i,
    /^Le (.+) a écrit\s*:\s*$/i,
];

/** A reply header line ("On ... wrote:"), or null. */
function attributionOf(line: string): Attribution | null {
    for (const pattern of WROTE_PATTERNS) {
        const match = pattern.exec(line.trim());
        if (!match) continue;
        const body = match.slice(1).join(" ");
        const author = mailboxIn(body);
        let name = author?.name ?? "";
        if (author && !name) {
            name = body.slice(0, body.indexOf(author.address)).trim();
        }
        // The date runs up to its time or year; the name follows it.
        name = name
            .replace(/^.*(?:\d{1,2}:\d{2}(?:\s*[AP]M)?|\b\d{4}\b)[,\s]*/i, "")
            .replace(/^odesílatel\s+/i, "")
            .replace(/[\s<,]+$/, "")
            .trim();
        const datePart =
            /^(.*(?:\d{1,2}:\d{2}(?:\s*[AP]M)?|\b\d{4}\b))/i.exec(body)?.[1] ??
            body;
        return {
            author: author ? { address: author.address, name } : null,
            at: parseClaimedDate(datePart),
        };
    }
    return null;
}

const SEPARATORS: readonly RegExp[] = [
    /^-{2,}\s*Original Message\s*-{2,}$/i,
    /^-{2,}\s*Forwarded message\s*-{2,}$/i,
    /^Begin forwarded message:?$/i,
    /^-{2,}\s*Původní zpráva\s*-{2,}$/i,
    /^-{2,}\s*Přeposlaná zpráva\s*-{2,}$/i,
    /^-{2,}\s*Původní e-mail\s*-{2,}$/i,
    /^-{2,}\s*Přeposlaný e-mail\s*-{2,}$/i,
    /^_{10,}$/,
];

const FROM_KEYS = /^(From|Od|Von|De)\s*:\s*(.+)$/i;
const DATE_KEYS = /^(Sent|Date|Odesláno|Datum|Gesendet|Envoyé)\s*:\s*(.+)$/i;
const TO_KEYS = /^(To|Komu|An|À)\s*:/i;
const SUBJECT_KEYS = /^(Subject|Předmět|Betreff|Objet|Věc)\s*:/i;

/**
 * A forwarded or original-message header block starting at `index`, or
 * null: From and a date and a subject (or To) within a few lines.
 */
function headerBlockAt(
    lines: readonly Line[],
    index: number,
): { end: number; attribution: Attribution } | null {
    const first = lines[index];
    if (!first) return null;
    const from = FROM_KEYS.exec(first.text.trim());
    if (!from) return null;
    let at: Date | null = null;
    let sawDate = false;
    let sawSubjectOrTo = false;
    let end = index;
    for (let i = index + 1; i < Math.min(lines.length, index + 8); i++) {
        const line = lines[i];
        if (!line || line.depth !== first.depth) break;
        const text = line.text.trim();
        if (!text) {
            if (sawDate && sawSubjectOrTo) break;
            continue;
        }
        const date = DATE_KEYS.exec(text);
        if (date) {
            sawDate = true;
            at = parseClaimedDate(date[2] ?? "");
            end = i;
            continue;
        }
        if (
            TO_KEYS.test(text) ||
            SUBJECT_KEYS.test(text) ||
            /^(Cc|Kopie)\s*:/i.test(text)
        ) {
            sawSubjectOrTo = true;
            end = i;
            continue;
        }
        break;
    }
    if (!sawDate || !sawSubjectOrTo) return null;
    return { end, attribution: { author: mailboxIn(from[2] ?? ""), at } };
}

/** The lines split into parts at quote changes, reply headers and header blocks. */
function partsOf(lines: readonly Line[]): Part[] {
    const parts: Part[] = [];
    // Extra depth added by a text-only quote (a header block) per base depth.
    const shift: number[] = [];
    let pending: Attribution | null = null;
    const current = (): Part | undefined => parts.at(-1);
    const open = (depth: number, attribution: Attribution | null) => {
        parts.push({
            depth,
            author: attribution?.author ?? null,
            at: attribution?.at ?? null,
            lines: [],
        });
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        // Deeper base depth resets text-only shifts beyond it.
        shift.length = Math.min(shift.length, line.depth + 1);
        const depth = line.depth + (shift[line.depth] ?? 0);
        const text = line.text;
        const trimmed = text.trim();

        if (trimmed && SEPARATORS.some((pattern) => pattern.test(trimmed))) {
            const block = headerBlockAt(lines, i + 1);
            shift[line.depth] = (shift[line.depth] ?? 0) + 1;
            open(
                line.depth + (shift[line.depth] ?? 0),
                block?.attribution ?? null,
            );
            if (block) i = block.end;
            continue;
        }
        const block = trimmed ? headerBlockAt(lines, i) : null;
        if (block && (current()?.lines.some((l) => l.trim()) ?? false)) {
            shift[line.depth] = (shift[line.depth] ?? 0) + 1;
            open(line.depth + (shift[line.depth] ?? 0), block.attribution);
            i = block.end;
            continue;
        }
        const attribution = trimmed ? attributionOf(trimmed) : null;
        if (attribution) {
            // Its quote follows: by markup, `>`, or (plain Outlook style)
            // simply the rest of the message.
            const next = lines.slice(i + 1).find((l) => l.text.trim());
            const last = current();
            const startsItsQuote =
                line.depth > 0 &&
                (!last ||
                    last.depth < line.depth ||
                    !last.lines.some((l) => l.trim()));
            if (next && next.depth > line.depth) {
                pending = attribution;
            } else if (startsItsQuote) {
                // Apple Mail quotes the header itself: the quote is at its depth.
                if (
                    !last ||
                    last.depth !== depth ||
                    last.lines.some((l) => l.trim())
                ) {
                    open(depth, attribution);
                } else {
                    last.author = attribution.author;
                    last.at = attribution.at;
                }
            } else {
                shift[line.depth] = (shift[line.depth] ?? 0) + 1;
                open(line.depth + (shift[line.depth] ?? 0), attribution);
            }
            continue;
        }
        const last = current();
        if (!last || last.depth !== depth) {
            open(depth, depth > (last?.depth ?? 0) ? pending : null);
            if (depth > (last?.depth ?? 0)) pending = null;
        }
        current()?.lines.push(text);
    }
    return parts.filter((part) => part.lines.some((l) => l.trim()));
}

const CLOSINGS: readonly RegExp[] = [
    /^(best|kind|warm|many)?\s*regards,?$/i,
    /^(best|cheers|thanks|thank you|thanks again|all the best|sincerely|yours( sincerely| truly)?),?$/i,
    /^(s\s+)?(pozdravem|přátelským pozdravem|pěkným pozdravem|úctou)[,.!]?$/i,
    /^(s\s+)?pozdravem\s+a\s+přáním.*$/i,
    /^(děkuji|díky|děkuju|předem děkuji)[,.!]*\s*(a\s+zdravím)?[,.!]?$/i,
    /^(zdravím|mějte se|hezký den)[,.!]?$/i,
    /^(mit freundlichen grüßen|viele grüße|beste grüße),?$/i,
];

const DISCLAIMER =
    /(confidential|intended (solely )?for|intended recipient|privileged|if you (have )?received this|důvěrn|určen[aáý]? výhradně|určena pouze|pokud jste (tuto )?(zprávu|e-mail)|nejste[- ]li zamýšlen|tento e-mail|this e-?mail (and any|is))/i;

/** A paragraph-start index where a trailing disclaimer begins, or -1. */
function disclaimerStart(lines: readonly string[]): number {
    // Paragraphs from the end: the disclaimer is the trailing run of them.
    let start = -1;
    let i = lines.length;
    while (i > 0) {
        let j = i - 1;
        while (j >= 0 && !lines[j]?.trim()) j--;
        if (j < 0) break;
        let k = j;
        while (k > 0 && lines[k - 1]?.trim()) k--;
        const paragraph = lines.slice(k, j + 1).join(" ");
        if (paragraph.length >= 60 && DISCLAIMER.test(paragraph)) {
            start = k;
            i = k;
            continue;
        }
        break;
    }
    return start;
}

/** Where a part's signature starts, or -1. */
function signatureStart(lines: readonly string[]): number {
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] ?? "";
        if (line === "-- " || line.trim() === "--") return i;
    }
    // A closing in the last lines, followed only by a few short lines.
    const content = lines
        .map((line, index) => ({ line: line.trim(), index }))
        .filter((entry) => entry.line);
    const tail = content.slice(-12);
    for (let t = 0; t < tail.length; t++) {
        const entry = tail[t];
        if (!entry || !CLOSINGS.some((pattern) => pattern.test(entry.line))) {
            continue;
        }
        const after = tail.slice(t + 1);
        if (after.length === 0) return -1;
        if (after.length <= 10 && after.every((e) => e.line.length <= 100)) {
            return entry.index;
        }
    }
    return -1;
}

function clean(lines: readonly string[]): string {
    return lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

interface Piece {
    role: SegmentRole;
    depth: number;
    author: ParsedMailbox | null;
    at: Date | null;
    text: string;
}

function piecesOf(part: Part): Piece[] {
    const quoted = part.depth > 0;
    let lines = part.lines;
    const pieces: Piece[] = [];
    const disclaimer = disclaimerStart(lines);
    let disclaimerText = "";
    if (disclaimer >= 0) {
        disclaimerText = clean(lines.slice(disclaimer));
        lines = lines.slice(0, disclaimer);
    }
    const signature = signatureStart(lines);
    const body = clean(signature >= 0 ? lines.slice(0, signature) : lines);
    const signatureText =
        signature >= 0
            ? clean(lines.slice(signature).filter((l) => l.trim() !== "--"))
            : "";
    const base = { depth: part.depth, author: part.author, at: part.at };
    if (body)
        pieces.push({ ...base, role: quoted ? "quoted" : "body", text: body });
    if (signatureText) {
        pieces.push({
            ...base,
            role: quoted ? "quoted_signature" : "signature",
            text: signatureText,
        });
    }
    if (disclaimerText) {
        pieces.push({ ...base, role: "disclaimer", text: disclaimerText });
    }
    return pieces;
}

class ParticipantBook {
    readonly list: MailParticipant[] = [];

    add(
        mailbox: ParsedMailbox | null | undefined,
        role: ParticipantRole,
        authenticated = false,
    ): string | null {
        if (!mailbox?.address) return null;
        const address = mailbox.address.toLowerCase();
        let participant = this.list.find((p) => p.address === address);
        if (!participant) {
            participant = {
                ref: `p${this.list.length + 1}`,
                roles: [],
                displayName: mailbox.name || null,
                address,
                authenticated: false,
            };
            this.list.push(participant);
        }
        if (!participant.roles.includes(role)) {
            participant.roles = [...participant.roles, role];
        }
        if (!participant.displayName && mailbox.name) {
            participant.displayName = mailbox.name;
        }
        if (authenticated) participant.authenticated = true;
        return participant.ref;
    }
}

/** Segments and participants of a mail. */
export function segmentMail(input: SegmentInput): SegmentedMail {
    const book = new ParticipantBook();
    const fromRef = book.add(input.from, "from", input.fromAuthenticated);
    book.add(input.sender, "sender");
    for (const mailbox of input.to ?? []) book.add(mailbox, "to");
    for (const mailbox of input.cc ?? []) book.add(mailbox, "cc");
    for (const mailbox of input.replyTo ?? []) book.add(mailbox, "reply_to");

    const text = input.html ? htmlToText(input.html) : (input.text ?? "");
    const segments: ContentSegment[] = [];
    for (const part of partsOf(quotedLines(text))) {
        for (const piece of piecesOf(part)) {
            const own = piece.depth === 0;
            const ref =
                piece.role === "disclaimer"
                    ? null
                    : own
                      ? fromRef
                      : book.add(piece.author, "quoted_author");
            segments.push({
                index: segments.length,
                role: piece.role,
                participantRef: ref,
                depth: piece.depth,
                at: own ? input.sentAt : piece.at,
                text: piece.text,
            });
        }
    }
    return { participants: book.list, segments };
}
