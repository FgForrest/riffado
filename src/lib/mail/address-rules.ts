/**
 * How Klepna's mail addresses are named. Pure: the database applies these
 * candidates in order and keeps the first one free (`addresses.ts`).
 *
 * - A mailbox is the local part of the owner's verified email, made safe:
 *   `jan.novotny@company.example` -> `jan.novotny`.
 * - A folder's address is the mailbox plus `+` and an alias from the
 *   folder's path (`jan.novotny+weekly`); an Organization folder's is the
 *   nickname plus `-` and the alias (`acme-weekly`).
 * - A secret address is any personal address plus `.` and a 50-bit token.
 */

import { randomInt } from "node:crypto";

/** RFC 5321: a local part is at most 64 octets. */
export const MAX_LOCAL_PART = 64;
export const MAX_MAILBOX_NAME = 40;
/** The secret's token: 10 base32 characters, 50 bits. */
export const SECRET_TOKEN_LENGTH = 10;
/** Room a secret address adds to the address it extends: `.` and the token. */
const SECRET_SUFFIX = 1 + SECRET_TOKEN_LENGTH;

/** Local parts no mailbox may take, whatever the nickname. */
export const RESERVED_LOCAL_PARTS: readonly string[] = [
    "postmaster",
    "abuse",
    "mailer-daemon",
    "noreply",
    "no-reply",
    "hostmaster",
    "webmaster",
    "root",
];

const SPECIAL_LETTERS: Readonly<Record<string, string>> = {
    ß: "ss",
    ł: "l",
    Ł: "l",
    ø: "o",
    Ø: "o",
    æ: "ae",
    Æ: "ae",
    œ: "oe",
    Œ: "oe",
    đ: "d",
    Đ: "d",
    ð: "d",
    þ: "th",
    ı: "i",
};

/** Lowercase ASCII letters and digits of `text`, accents dropped. */
function transliterate(text: string): string {
    return text
        .replace(/[ßłŁøØæÆœŒđĐðþı]/g, (letter) => SPECIAL_LETTERS[letter] ?? "")
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase();
}

/**
 * `text` as one part of a local part: letters, digits and the separators
 * `allowed` lets through, runs of a separator collapsed, none at the ends.
 */
function slugOf(text: string, allowed: RegExp, separators: string): string {
    let slug = "";
    for (const char of transliterate(text)) {
        if (allowed.test(char)) slug += char;
    }
    for (const separator of separators) {
        const escaped = `\\${separator}`;
        slug = slug.replace(new RegExp(`${escaped}{2,}`, "g"), separator);
    }
    const ends = new RegExp(`^[${separators}]+|[${separators}]+$`, "g");
    return slug.replace(ends, "");
}

/** A folder path segment as part of an alias: `[a-z0-9-]`, or `folder`. */
export function aliasSegment(name: string): string {
    return slugOf(name, /[a-z0-9-]/, "-") || "folder";
}

/** A nickname as configured: lowercase, `[a-z0-9]`, at least one. */
export function normalizeNickname(nickname: string): string {
    const normalized = slugOf(nickname, /[a-z0-9]/, "");
    return normalized || "org";
}

/** Whether a local part is one an address may have: ASCII, unquoted. */
export function isAcceptableLocalPart(localPart: string): boolean {
    return (
        localPart.length > 0 &&
        localPart.length <= MAX_LOCAL_PART &&
        /^[a-z0-9.+-]+$/.test(localPart) &&
        !localPart.startsWith(".") &&
        !localPart.endsWith(".") &&
        !localPart.includes("..")
    );
}

/** A recipient's local part as lookups compare it, or null if never ours. */
export function normalizeRecipientLocalPart(localPart: string): string | null {
    const lowered = localPart.toLowerCase();
    return isAcceptableLocalPart(lowered) ? lowered : null;
}

function withNumber(base: string, n: number, max: number): string {
    const suffix = String(n);
    return `${base.slice(0, max - suffix.length).replace(/[.-]+$/, "")}${suffix}`;
}

/**
 * The names a mailbox may take, best first: the verified email's local part
 * made safe, then numbered. `nicknames` are the configured nickname and every
 * former one; a name in the Organization's namespace (`acme-...`) loses its
 * hyphen.
 */
export function* mailboxNameCandidates(
    email: string,
    nicknames: readonly string[],
): Generator<string> {
    const local = email.slice(0, Math.max(0, email.lastIndexOf("@")));
    let base = slugOf(local, /[a-z0-9.-]/, ".-").slice(0, MAX_MAILBOX_NAME);
    base = base.replace(/[.-]+$/, "") || "user";
    for (const nickname of nicknames) {
        if (base.startsWith(`${nickname}-`)) {
            base = `${nickname}${base.slice(nickname.length + 1)}`;
        }
    }
    const reserved = new Set([...RESERVED_LOCAL_PARTS, ...nicknames]);
    if (!reserved.has(base)) yield base;
    for (let n = 2; ; n++) {
        const candidate = withNumber(base, n, MAX_MAILBOX_NAME);
        if (!reserved.has(candidate)) yield candidate;
    }
}

/**
 * The local parts a folder's address may take, best first: the last path
 * segment, then the last two joined, and so on up to the whole path, then
 * the whole path numbered. `prefix` is the namespace (`jan.novotny+`,
 * `acme-`); every candidate leaves room for a secret's suffix.
 */
export function* folderAddressCandidates(
    prefix: string,
    pathFromRoot: readonly string[],
): Generator<string> {
    const segments = pathFromRoot.map(aliasSegment);
    const room = MAX_LOCAL_PART - SECRET_SUFFIX - prefix.length;
    if (room < 2) {
        throw new Error("The address prefix leaves no room for an alias");
    }
    const fit = (alias: string) => alias.slice(0, room).replace(/-+$/, "");
    let longest = segments.at(-1) ?? "folder";
    for (let k = 1; k <= segments.length; k++) {
        const alias = fit(segments.slice(segments.length - k).join(""));
        longest = alias || longest;
        if (alias) yield `${prefix}${alias}`;
    }
    for (let n = 2; ; n++) {
        yield `${prefix}${withNumber(longest, n, room)}`;
    }
}

/** A manually chosen alias, made safe, or null when nothing usable is left. */
export function manualFolderAddress(
    prefix: string,
    alias: string,
): string | null {
    const room = MAX_LOCAL_PART - SECRET_SUFFIX - prefix.length;
    const slug = aliasSegment(alias);
    if (slug === "folder" && !/folder/i.test(alias)) return null;
    if (slug.length > room) return null;
    return `${prefix}${slug}`;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A fresh secret token: 10 lowercase base32 characters (50 bits). */
export function secretToken(): string {
    let token = "";
    for (let i = 0; i < SECRET_TOKEN_LENGTH; i++) {
        token += BASE32[randomInt(32)];
    }
    return token;
}

/** A secret address extending `base`: `<base>.<token>`. */
export function secretLocalPart(base: string, token = secretToken()): string {
    const localPart = `${base}.${token}`;
    if (localPart.length > MAX_LOCAL_PART) {
        throw new Error("The address is too long for a secret address");
    }
    return localPart;
}

/** The mailbox's prefix for its folders' addresses. */
export function personalFolderPrefix(mailbox: string): string {
    return `${mailbox}+`;
}

/** The Organization's prefix for its folders' addresses. */
export function organizationFolderPrefix(nickname: string): string {
    return `${nickname}-`;
}
