import { type DNSResolver, dkimVerify } from "mailauth";
import { parseAddressList } from "@/lib/mail/address-list";
import {
    dkimTags,
    headerValuesOf,
    readRawHeaders,
    withDkimSignatures,
} from "@/lib/mail/headers";
import type { DkimSignature, MessageFacts } from "@/lib/mail/policy";

/** Signatures verified per message: aligned ones first. */
export const MAX_DKIM_SIGNATURES = 3;

/** What the authentication of a message found, stored (encrypted) with it. */
export interface MailAuth {
    dkim: { domain: string; selector: string | null; result: string }[];
    /** The receiver's SPF result: shown, never used to authorize. */
    spf: string | null;
    senderVerified: boolean;
}

/** One verified signature as mailauth reports it at runtime. */
interface VerifierResult {
    signingDomain?: string;
    selector?: string;
    status?: { result?: string };
    signTime?: string | Date;
    signingHeaders?: { headers?: string[] };
}

function domainOf(address: string): string {
    return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** The addresses in a signature's signed To and Cc lines. */
function signedRecipients(lines: readonly string[]): string[] {
    const addresses: string[] = [];
    for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        if (name !== "to" && name !== "cc") continue;
        for (const mailbox of parseAddressList(line.slice(colon + 1))) {
            addresses.push(mailbox.address);
        }
    }
    return addresses;
}

/**
 * Verifies a raw message's DKIM signatures (at most `MAX_DKIM_SIGNATURES`,
 * those of the From domain first) and reads its From header, as the policy
 * needs them. `resolver` replaces DNS in tests; `now` is when it arrived.
 */
export async function authenticateMessage(
    raw: Buffer,
    options: { resolver?: DNSResolver; now: Date },
): Promise<MessageFacts> {
    const headers = readRawHeaders(raw);
    const fromValues = headerValuesOf(headers, "from");
    const fromAddresses =
        fromValues.length === 1
            ? parseAddressList(fromValues[0] ?? "").map((m) => m.address)
            : fromValues.flatMap((value) =>
                  parseAddressList(value).map((m) => m.address),
              );
    const fromDomain =
        fromAddresses.length === 1 ? domainOf(fromAddresses[0] ?? "") : null;

    const signatures = headers.filter(
        (header) => header.name.toLowerCase() === "dkim-signature",
    );
    const ranked = signatures
        .map((header, index) => ({
            index,
            aligned:
                fromDomain !== null &&
                (dkimTags(header.value).get("d") ?? "").toLowerCase() ===
                    fromDomain,
        }))
        .sort(
            (a, b) =>
                Number(b.aligned) - Number(a.aligned) || a.index - b.index,
        )
        .slice(0, MAX_DKIM_SIGNATURES);
    const keep = new Set(ranked.map((entry) => entry.index));
    const verified =
        signatures.length === 0
            ? []
            : (
                  await dkimVerify(
                      withDkimSignatures(raw, (_header, index) =>
                          keep.has(index),
                      ),
                      {
                          resolver: options.resolver,
                          curTime: options.now,
                          minBitLength: 1024,
                      },
                  )
              ).results;

    const dkim: DkimSignature[] = (verified as VerifierResult[])
        .filter((result) => result.signingDomain)
        .map((result) => {
            const signTime = result.signTime ? new Date(result.signTime) : null;
            return {
                domain: (result.signingDomain ?? "").toLowerCase(),
                result: result.status?.result ?? "none",
                signedRecipients: signedRecipients(
                    result.signingHeaders?.headers ?? [],
                ),
                signedAt:
                    signTime && !Number.isNaN(signTime.getTime())
                        ? signTime
                        : null,
            };
        });
    return {
        fromHeaders: fromValues.length,
        fromAddresses,
        dkim,
        receivedAt: options.now,
    };
}

/** What is kept of an authentication: no addresses, only domains and results. */
export function summarizeAuth(
    facts: MessageFacts,
    spf: string | null,
    senderVerified: boolean,
): MailAuth {
    return {
        dkim: facts.dkim.map((signature) => ({
            domain: signature.domain,
            selector: null,
            result: signature.result,
        })),
        spf,
        senderVerified,
    };
}
