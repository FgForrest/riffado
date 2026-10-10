import { env } from "@/lib/env";
import { normalizeNickname } from "@/lib/mail/address-rules";
import { isSsoEnabled } from "@/lib/sso/config";

/**
 * Whether inbound mail is on: a mail domain, both mail secrets, and single
 * sign-on, which is what proves an address's owner owns their email.
 */
export function isMailEnabled(): boolean {
    return Boolean(
        env.MAIL_DOMAIN &&
            env.MAIL_ADDRESS_HASH_SECRET &&
            env.MAIL_INGEST_SECRET &&
            isSsoEnabled(),
    );
}

/** The mail domain; throws while mail is off. */
export function mailDomain(): string {
    if (!env.MAIL_DOMAIN) throw new Error("Inbound mail is not configured");
    return env.MAIL_DOMAIN;
}

/** The current Organization nickname. */
export function orgNickname(): string {
    return normalizeNickname(env.MAIL_ORG_NICKNAME);
}

/** The current nickname and every former one, which stay reserved. */
export function allOrgNicknames(): string[] {
    return [
        ...new Set([
            orgNickname(),
            ...env.MAIL_FORMER_ORG_NICKNAMES.map(normalizeNickname),
        ]),
    ];
}

export function maxMessageBytes(): number {
    return env.MAIL_MAX_MESSAGE_MB * 1024 * 1024;
}

/** The full address of a local part on the mail domain. */
export function addressOf(localPart: string): string {
    return `${localPart}@${mailDomain()}`;
}
