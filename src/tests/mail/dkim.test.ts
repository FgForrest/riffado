import { describe, expect, it } from "vitest";
import { authenticateMessage, MAX_DKIM_SIGNATURES } from "@/lib/mail/dkim";
import {
    rawMessage,
    signMessage,
    testResolver,
    testSigner,
} from "@/tests/mail/dkim-fixtures";

const company = testSigner("company.example");
const other = testSigner("other.example", "s1");
const resolver = testResolver([company, other]);

const HEADERS = [
    "From: Jan Novotny <jan@company.example>",
    "To: Weekly <acme-weekly@klepna.example>, eva@client.example",
    "Cc: jan@klepna.example",
    "Subject: Conditions",
    "Date: Fri, 09 Oct 2026 14:02:00 +0200",
    "Message-ID: <m1@company.example>",
];

describe("DKIM verification", () => {
    it("passes a signature of the From domain and reads its signed recipients", async () => {
        const now = new Date();
        const raw = await signMessage(
            rawMessage(HEADERS, "Below are Eva's conditions."),
            company,
            { signTime: now },
        );
        const facts = await authenticateMessage(raw, { resolver, now });
        expect(facts.fromHeaders).toBe(1);
        expect(facts.fromAddresses).toEqual(["jan@company.example"]);
        expect(facts.dkim).toHaveLength(1);
        expect(facts.dkim[0]).toMatchObject({
            domain: "company.example",
            result: "pass",
        });
        expect([...(facts.dkim[0]?.signedRecipients ?? [])].sort()).toEqual(
            [
                "acme-weekly@klepna.example",
                "eva@client.example",
                "jan@klepna.example",
            ].sort(),
        );
        expect(
            Math.abs((facts.dkim[0]?.signedAt?.getTime() ?? 0) - now.getTime()),
        ).toBeLessThan(2000);
    });

    it("fails a signature over a changed body", async () => {
        const raw = await signMessage(
            rawMessage(HEADERS, "Original."),
            company,
        );
        const tampered = Buffer.from(
            raw.toString().replace("Original.", "Changed."),
        );
        const facts = await authenticateMessage(tampered, {
            resolver,
            now: new Date(),
        });
        expect(facts.dkim[0]?.result).not.toBe("pass");
    });

    it("names only the recipients of the signed lines, not an unsigned To above them", async () => {
        const raw = await signMessage(rawMessage(HEADERS, "Hello."), company);
        const forged = Buffer.concat([
            Buffer.from("To: acme-board@klepna.example\r\n"),
            raw,
        ]);
        const facts = await authenticateMessage(forged, {
            resolver,
            now: new Date(),
        });
        for (const signature of facts.dkim) {
            expect(signature.signedRecipients).not.toContain(
                "acme-board@klepna.example",
            );
        }
    });

    it("counts From headers and mailboxes", async () => {
        const two = rawMessage(
            [
                "From: jan@company.example",
                "From: eva@company.example",
                "Subject: x",
            ],
            "x",
        );
        const facts = await authenticateMessage(Buffer.from(two), {
            resolver,
            now: new Date(),
        });
        expect(facts.fromHeaders).toBe(2);
        expect(facts.dkim).toEqual([]);
        const many = rawMessage(
            ["From: jan@company.example, eva@company.example", "Subject: x"],
            "x",
        );
        expect(
            (
                await authenticateMessage(Buffer.from(many), {
                    resolver,
                    now: new Date(),
                })
            ).fromAddresses,
        ).toEqual(["jan@company.example", "eva@company.example"]);
    });

    it(`verifies at most ${MAX_DKIM_SIGNATURES} signatures, the From domain's first`, async () => {
        let raw: Buffer = Buffer.from(rawMessage(HEADERS, "Hello."));
        for (let i = 0; i < 4; i++) {
            raw = await signMessage(raw.toString(), other);
        }
        raw = await signMessage(raw.toString(), company);
        const facts = await authenticateMessage(raw, {
            resolver,
            now: new Date(),
        });
        expect(facts.dkim).toHaveLength(MAX_DKIM_SIGNATURES);
        expect(facts.dkim.map((signature) => signature.domain)).toContain(
            "company.example",
        );
        expect(
            facts.dkim.find(
                (signature) => signature.domain === "company.example",
            )?.result,
        ).toBe("pass");
    });
});
