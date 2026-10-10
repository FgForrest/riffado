import { describe, expect, it } from "vitest";
import {
    type DkimSignature,
    evaluateRecipient,
    type MailUser,
    type MessageFacts,
    type RecipientTarget,
} from "@/lib/mail/policy";

const NOW = new Date("2026-10-10T12:00:00Z");
const OPTIONS = { maxSignatureAgeHours: 72 };

const jan: MailUser = {
    userId: "u-jan",
    email: "jan@company.example",
    active: true,
};
const eva: MailUser = {
    userId: "u-eva",
    email: "eva@company.example",
    active: true,
};

function signature(overrides: Partial<DkimSignature> = {}): DkimSignature {
    return {
        domain: "company.example",
        result: "pass",
        signedRecipients: ["jan@klepna.example"],
        signedAt: new Date(NOW.getTime() - 60_000),
        ...overrides,
    };
}

function message(overrides: Partial<MessageFacts> = {}): MessageFacts {
    return {
        fromHeaders: 1,
        fromAddresses: ["jan@company.example"],
        dkim: [signature()],
        receivedAt: NOW,
        ...overrides,
    };
}

const mailbox: RecipientTarget = {
    kind: "personal",
    addressKind: "mailbox",
    address: "jan@klepna.example",
    owner: jan,
};
const weekly: RecipientTarget = {
    kind: "organization",
    address: "acme-weekly@klepna.example",
};
const secret: RecipientTarget = {
    kind: "secret",
    address: "jan.abcdefghij@klepna.example",
    owner: jan,
};

function verdict(
    target: RecipientTarget | null,
    facts: Partial<MessageFacts> = {},
    senderUser: MailUser | null = null,
) {
    return evaluateRecipient({
        message: message(facts),
        target,
        senderUser,
        options: OPTIONS,
    });
}

describe("personal addresses", () => {
    it("accept the owner's own mail, signed by their domain", () => {
        expect(verdict(mailbox)).toEqual({
            accept: true,
            ownerUserId: "u-jan",
            senderVerified: true,
        });
    });

    it("refuse an SPF-only pass: no DKIM signature of the From domain", () => {
        expect(verdict(mailbox, { dkim: [] })).toEqual({
            accept: false,
            reason: "not_signed",
        });
        expect(
            verdict(mailbox, {
                dkim: [signature({ domain: "relay.example" })],
            }),
        ).toEqual({ accept: false, reason: "not_signed" });
        expect(
            verdict(mailbox, { dkim: [signature({ result: "fail" })] }),
        ).toEqual({ accept: false, reason: "not_signed" });
    });

    it("refuse a subdomain's or parent's signature: d= must equal the From domain", () => {
        expect(
            verdict(mailbox, {
                dkim: [signature({ domain: "mail.company.example" })],
            }),
        ).toMatchObject({ accept: false });
    });

    it("refuse mail from anyone but the owner", () => {
        expect(
            verdict(mailbox, { fromAddresses: ["eva@company.example"] }),
        ).toEqual({ accept: false, reason: "sender_mismatch" });
    });

    it("refuse two From headers or two mailboxes in one", () => {
        expect(verdict(mailbox, { fromHeaders: 2 })).toEqual({
            accept: false,
            reason: "from_header",
        });
        expect(
            verdict(mailbox, {
                fromAddresses: ["jan@company.example", "eva@company.example"],
            }),
        ).toEqual({ accept: false, reason: "from_header" });
    });

    it("refuse a signature without t=, or outside the replay window", () => {
        expect(
            verdict(mailbox, { dkim: [signature({ signedAt: null })] }),
        ).toEqual({ accept: false, reason: "signature_untimed" });
        expect(
            verdict(mailbox, {
                dkim: [
                    signature({
                        signedAt: new Date(NOW.getTime() - 73 * 3600 * 1000),
                    }),
                ],
            }),
        ).toEqual({ accept: false, reason: "signature_stale" });
        expect(
            verdict(mailbox, {
                dkim: [
                    signature({
                        signedAt: new Date(NOW.getTime() + 3600 * 1000),
                    }),
                ],
            }),
        ).toEqual({ accept: false, reason: "signature_stale" });
    });

    it("accept the owner's BCC: the envelope is not signed and need not be", () => {
        expect(
            verdict(mailbox, {
                dkim: [
                    signature({ signedRecipients: ["client@client.example"] }),
                ],
            }),
        ).toMatchObject({ accept: true });
    });

    it("refuse while the owner is inactive", () => {
        expect(
            verdict({ ...mailbox, owner: { ...jan, active: false } }),
        ).toEqual({ accept: false, reason: "owner_inactive" });
    });
});

describe("Organization addresses", () => {
    const toWeekly = {
        fromAddresses: ["eva@company.example"],
        dkim: [signature({ signedRecipients: ["acme-weekly@klepna.example"] })],
    };

    it("accept any active user's signed mail, owned by the sender", () => {
        expect(verdict(weekly, toWeekly, eva)).toEqual({
            accept: true,
            ownerUserId: "u-eva",
            senderVerified: true,
        });
    });

    it("refuse a BCC or a replay: the address must be in a signed To or Cc", () => {
        expect(
            verdict(
                weekly,
                {
                    ...toWeekly,
                    dkim: [
                        signature({
                            signedRecipients: ["client@client.example"],
                        }),
                    ],
                },
                eva,
            ),
        ).toEqual({ accept: false, reason: "not_addressed" });
        expect(
            verdict(
                weekly,
                { ...toWeekly, dkim: [signature({ signedRecipients: [] })] },
                eva,
            ),
        ).toEqual({ accept: false, reason: "not_addressed" });
    });

    it("refuse a sender who is no user, or an inactive one", () => {
        expect(verdict(weekly, toWeekly, null)).toEqual({
            accept: false,
            reason: "not_a_user",
        });
        expect(verdict(weekly, toWeekly, { ...eva, active: false })).toEqual({
            accept: false,
            reason: "owner_inactive",
        });
    });
});

describe("secret addresses", () => {
    it("accept anyone, marking an unverified sender", () => {
        expect(
            verdict(secret, {
                fromAddresses: ["client@client.example"],
                dkim: [],
            }),
        ).toEqual({
            accept: true,
            ownerUserId: "u-jan",
            senderVerified: false,
        });
        expect(
            verdict(secret, {
                fromAddresses: ["client@client.example"],
                dkim: [signature({ domain: "client.example" })],
            }),
        ).toEqual({ accept: true, ownerUserId: "u-jan", senderVerified: true });
    });

    it("still refuse a message with two From mailboxes", () => {
        expect(verdict(secret, { fromHeaders: 2 })).toEqual({
            accept: false,
            reason: "from_header",
        });
    });
});

it("refuses an unknown address", () => {
    expect(verdict(null)).toEqual({ accept: false, reason: "unknown_address" });
});
