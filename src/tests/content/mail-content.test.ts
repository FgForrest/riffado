import { describe, expect, it } from "vitest";
import { mailContentFrom } from "@/lib/content/mail-content";
import { renderMailForModel } from "@/lib/content/render-mail";

const source = {
    itemId: "m1",
    contentId: "c1",
    revision: 2,
    language: null,
    participants: [
        {
            ref: "p1",
            roles: ["from"],
            name: "Jan Novotny",
            address: "jan@company.example",
            authenticated: true,
        },
        {
            ref: "p2",
            roles: ["to", "unknown_role"],
            name: null,
            address: "eva@client.example",
            authenticated: false,
        },
        {
            ref: "p3",
            roles: ["quoted_author"],
            name: "Eva Buyer",
            address: null,
            authenticated: false,
        },
    ],
    segments: [
        {
            index: 0,
            role: "body" as const,
            participantRef: "p1",
            depth: 0,
            at: "2026-10-09T12:02:00.000Z",
            text: "Eva's conditions are below, we answer by Friday.",
        },
        {
            index: 1,
            role: "signature" as const,
            participantRef: "p1",
            depth: 0,
            at: "2026-10-09T12:02:00.000Z",
            text: "Jan Novotny\nSales",
        },
        {
            index: 2,
            role: "quoted" as const,
            participantRef: "p3",
            depth: 1,
            at: "2026-10-08T15:40:00.000Z",
            text: "We can accept the price if delivery is in November.",
        },
        {
            index: 3,
            role: "quoted" as const,
            participantRef: "p3",
            depth: 2,
            at: null,
            text: "An older message already in the pile.",
            knownItemId: "m0",
        },
    ],
};

describe("mail content", () => {
    it("reads participants and segments as every kind's content", () => {
        const content = mailContentFrom(source);
        expect(content).toMatchObject({
            itemId: "m1",
            kind: "mail",
            sourceId: "c1",
            revision: 2,
        });
        expect(content.participants[1]?.roles).toEqual(["to"]);
        expect(content.segments[0]?.at).toEqual(
            new Date("2026-10-09T12:02:00.000Z"),
        );
        expect(content.segments[3]?.at).toBeNull();
    });

    it("renders references, roles and domains for a model, never addresses", () => {
        const text = renderMailForModel(mailContentFrom(source), {
            subject: "Conditions for November",
            sentAt: new Date("2026-10-09T12:02:00.000Z"),
        });
        expect(text).toContain("Subject: Conditions for November");
        expect(text).toContain(
            "- p1: Jan Novotny (from; company.example; verified)",
        );
        expect(text).toContain("- p2: (no name) (to; client.example)");
        expect(text).toContain("[#0 body p1]");
        expect(text).toContain("[#2 quoted p3 written 2026-10-08]");
        expect(text).not.toContain("jan@company.example");
        expect(text).not.toContain("eva@client.example");
        // Already in the pile: not read again.
        expect(text).not.toContain("An older message");
    });
});
