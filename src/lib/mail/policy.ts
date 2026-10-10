/**
 * Whether a message may be filed through one recipient address. Pure: the
 * ingest endpoint gathers the facts (headers, its own DKIM verification,
 * the address and the people behind it) and applies this per recipient.
 *
 * Sender identity rests on a passing DKIM signature whose `d=` equals the
 * From domain, never on SPF (DMARC passes on an SPF alignment alone) and
 * never on the From header by itself.
 */

/** One DKIM signature as the verifier judged it. */
export interface DkimSignature {
    /** The signing domain (`d=`), lowercase. */
    domain: string;
    result: string;
    /**
     * The addresses in the To and Cc header lines the signature covers,
     * lowercase: read from the signed lines themselves, so an unsigned To
     * added above them names nobody.
     */
    signedRecipients: readonly string[];
    /** `t=`, when the signature carries one. */
    signedAt: Date | null;
}

/** What the message says about itself, as parsed by the app. */
export interface MessageFacts {
    /** How many From headers the message has. */
    fromHeaders: number;
    /** The mailboxes in its From header, lowercase. */
    fromAddresses: readonly string[];
    dkim: readonly DkimSignature[];
    receivedAt: Date;
}

/** Someone a recipient address may belong to, or a sender may be. */
export interface MailUser {
    userId: string;
    /** The SSO-verified email, lowercase. */
    email: string;
    /** Signed in by single sign-on recently enough to receive mail. */
    active: boolean;
}

/** The address a recipient named, as the lookup found it. */
export type RecipientTarget =
    | {
          kind: "personal";
          /** `mailbox` (unfiled) or `folder`. */
          addressKind: "mailbox" | "folder";
          address: string;
          owner: MailUser;
      }
    | { kind: "organization"; address: string }
    | {
          kind: "secret";
          address: string;
          owner: MailUser;
      };

export type RefusalReason =
    | "unknown_address"
    | "address_inactive"
    | "from_header"
    | "not_signed"
    | "signature_untimed"
    | "signature_stale"
    | "sender_mismatch"
    | "owner_inactive"
    | "not_addressed"
    | "not_a_user";

export type RecipientVerdict =
    | {
          accept: true;
          /** Who owns the item: the address's owner, or the sender (D2). */
          ownerUserId: string;
          /** A passing aligned DKIM signature vouches for the From address. */
          senderVerified: boolean;
      }
    | { accept: false; reason: RefusalReason };

export interface PolicyOptions {
    /** `MAIL_MAX_SIGNATURE_AGE_HOURS`. */
    maxSignatureAgeHours: number;
    /** Clock skew a signature from the future is allowed. */
    futureSkewMs?: number;
}

function domainOf(address: string): string {
    return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * The passing DKIM signatures whose `d=` is the From domain exactly, or an
 * empty list when the From header is not one mailbox.
 */
export function alignedSignatures(
    message: MessageFacts,
): readonly DkimSignature[] {
    const [from] = message.fromAddresses;
    if (message.fromHeaders !== 1 || message.fromAddresses.length !== 1) {
        return [];
    }
    if (!from) return [];
    const fromDomain = domainOf(from);
    return message.dkim.filter(
        (signature) =>
            signature.result === "pass" &&
            signature.domain.toLowerCase() === fromDomain,
    );
}

type SignatureCheck =
    | { ok: true; signatures: readonly DkimSignature[] }
    | { ok: false; reason: RefusalReason };

/** Aligned, timed signatures within the replay window. */
function freshAlignedSignatures(
    message: MessageFacts,
    options: PolicyOptions,
): SignatureCheck {
    const aligned = alignedSignatures(message);
    if (aligned.length === 0) return { ok: false, reason: "not_signed" };
    const timed = aligned.filter((signature) => signature.signedAt !== null);
    if (timed.length === 0) return { ok: false, reason: "signature_untimed" };
    const now = message.receivedAt.getTime();
    const oldest = now - options.maxSignatureAgeHours * 60 * 60 * 1000;
    const newest = now + (options.futureSkewMs ?? 15 * 60 * 1000);
    const fresh = timed.filter((signature) => {
        const at = signature.signedAt?.getTime() ?? 0;
        return at >= oldest && at <= newest;
    });
    if (fresh.length === 0) return { ok: false, reason: "signature_stale" };
    return { ok: true, signatures: fresh };
}

/**
 * The verdict for one recipient. `senderUser` is the active-or-not user whose
 * verified email the From address is, if any (an Organization address needs
 * one).
 */
export function evaluateRecipient(input: {
    message: MessageFacts;
    target: RecipientTarget | null;
    senderUser: MailUser | null;
    options: PolicyOptions;
}): RecipientVerdict {
    const { message, target, senderUser, options } = input;
    if (!target) return { accept: false, reason: "unknown_address" };
    if (message.fromHeaders !== 1 || message.fromAddresses.length !== 1) {
        return { accept: false, reason: "from_header" };
    }
    const from = message.fromAddresses[0] ?? "";

    if (target.kind === "secret") {
        if (!target.owner.active) {
            return { accept: false, reason: "owner_inactive" };
        }
        const check = freshAlignedSignatures(message, options);
        return {
            accept: true,
            ownerUserId: target.owner.userId,
            senderVerified: check.ok,
        };
    }

    const check = freshAlignedSignatures(message, options);
    if (!check.ok) return { accept: false, reason: check.reason };

    if (target.kind === "personal") {
        if (from !== target.owner.email) {
            return { accept: false, reason: "sender_mismatch" };
        }
        if (!target.owner.active) {
            return { accept: false, reason: "owner_inactive" };
        }
        return {
            accept: true,
            ownerUserId: target.owner.userId,
            senderVerified: true,
        };
    }

    if (!senderUser || senderUser.email !== from) {
        return { accept: false, reason: "not_a_user" };
    }
    if (!senderUser.active) return { accept: false, reason: "owner_inactive" };
    const address = target.address.toLowerCase();
    if (
        !check.signatures.some((signature) =>
            signature.signedRecipients.includes(address),
        )
    ) {
        return { accept: false, reason: "not_addressed" };
    }
    return {
        accept: true,
        ownerUserId: senderUser.userId,
        senderVerified: true,
    };
}
