import { generateKeyPairSync } from "node:crypto";
import { type DNSResolver, dkimSign } from "mailauth";

/** A signing key for one test domain, and the DNS record that publishes it. */
export interface TestSigner {
    domain: string;
    selector: string;
    privateKey: string;
    record: string;
}

export function testSigner(domain: string, selector = "google"): TestSigner {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
    });
    return {
        domain,
        selector,
        privateKey: privateKey
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
        record: `v=DKIM1; k=rsa; p=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`,
    };
}

/** A DNS resolver that answers the signers' key records and nothing else. */
export function testResolver(signers: readonly TestSigner[]): DNSResolver {
    return async (name, type) => {
        const signer = signers.find(
            (candidate) =>
                type === "TXT" &&
                name.toLowerCase() ===
                    `${candidate.selector}._domainkey.${candidate.domain}`,
        );
        if (signer) return [[signer.record]];
        const error = new Error(`no ${type} record for ${name}`) as Error & {
            code: string;
        };
        error.code = "ENOTFOUND";
        throw error;
    };
}

/** `message` (CRLF lines) with a DKIM-Signature of `signer` prepended. */
export async function signMessage(
    message: string,
    signer: TestSigner,
    options: { headerList?: string[]; signTime?: Date } = {},
): Promise<Buffer> {
    const signed = await dkimSign(message, {
        signTime: options.signTime ?? new Date(),
        headerList: options.headerList ?? [
            "from",
            "to",
            "cc",
            "subject",
            "date",
            "message-id",
        ],
        signatureData: [
            {
                signingDomain: signer.domain,
                selector: signer.selector,
                privateKey: signer.privateKey,
            },
        ],
    } as Parameters<typeof dkimSign>[1]);
    return Buffer.from(signed.signatures + message);
}

/** A message from its header lines and body, CRLF line ends. */
export function rawMessage(headers: readonly string[], body: string): string {
    return `${headers.join("\r\n")}\r\n\r\n${body.replace(/\r?\n/g, "\r\n")}\r\n`;
}
