import { createHash, createHmac, hkdfSync } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Keyed hashes for inbound mail, under MAIL_ADDRESS_HASH_SECRET: its own
 * secret, so rotating API_TOKEN_HASH_SECRET (which `lookupHash` derives
 * from) never unhooks every address. Each use gets its own derived key.
 */

/** The key version new hashes are made with; stored with each address. */
export const MAIL_HASH_VERSION = 1;

const keys = new Map<string, Buffer>();

function keyFor(purpose: string): Buffer {
    const secret = env.MAIL_ADDRESS_HASH_SECRET;
    if (!secret) throw new Error("MAIL_ADDRESS_HASH_SECRET is not set");
    const cacheKey = `${purpose}\u0000${secret}`;
    let key = keys.get(cacheKey);
    if (!key) {
        key = Buffer.from(
            hkdfSync(
                "sha256",
                secret,
                "",
                `riffado:mail:${purpose}:v${MAIL_HASH_VERSION}`,
                32,
            ),
        );
        keys.set(cacheKey, key);
    }
    return key;
}

function hmac(purpose: string, ...parts: string[]): string {
    const mac = createHmac("sha256", keyFor(purpose));
    for (const part of parts) {
        mac.update(part);
        mac.update("\u0000");
    }
    return mac.digest("hex");
}

/** The lookup hash of a local part (lowercase, as received). */
export function localPartHash(localPart: string): string {
    return hmac("local-part", localPart.toLowerCase());
}

/** A participant's address, for finding mail by who took part. */
export function participantAddressHash(address: string): string {
    return hmac("participant", address.trim().toLowerCase());
}

/** One message for one owner, whatever brought it how often. */
export function rawMessageHash(ownerUserId: string, raw: Buffer): string {
    const digest = createHash("sha256").update(raw).digest("hex");
    return hmac("raw", ownerUserId, digest);
}

/** A `Message-ID` (or a thread root's), per owner. */
export function messageIdHash(ownerUserId: string, messageId: string): string {
    return hmac(
        "message-id",
        ownerUserId,
        messageId.trim().replace(/^<|>$/g, "").toLowerCase(),
    );
}
