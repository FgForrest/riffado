import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { htmlToText } from "@/lib/mail/html-text";
import { parseClaimedDate, segmentMail } from "@/lib/mail/segment";

const FIXTURES = join(__dirname, "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const JAN = { address: "jan@company.example", name: "Jan Novotny" };

function shape(result: ReturnType<typeof segmentMail>) {
    return result.segments.map((segment) => ({
        role: segment.role,
        depth: segment.depth,
        ref: segment.participantRef,
        text: segment.text,
    }));
}

describe("mail segmentation", () => {
    it("splits a Gmail reply: body, signature, quoted part with its author and signature", () => {
        const result = segmentMail({
            text: null,
            html: fixture("gmail-reply.html"),
            from: JAN,
            to: [{ address: "acme-weekly@klepna.example", name: "" }],
            sentAt: new Date("2026-10-09T12:02:00Z"),
            fromAuthenticated: true,
        });
        expect(shape(result)).toEqual([
            {
                role: "body",
                depth: 0,
                ref: "p1",
                text: "Eva's conditions are below, we answer by Friday.",
            },
            {
                role: "signature",
                depth: 0,
                ref: "p1",
                text: "Best regards,\nJan Novotny\nHead of Sales | Acme Industries\n+420 123 456 789",
            },
            {
                role: "quoted",
                depth: 1,
                ref: "p3",
                text: "We can accept the price if delivery is in November.",
            },
            {
                role: "quoted_signature",
                depth: 1,
                ref: "p3",
                text: "Eva Buyer\nHead of Purchasing, Client Ltd.",
            },
        ]);
        expect(result.participants).toEqual([
            {
                ref: "p1",
                roles: ["from"],
                displayName: "Jan Novotny",
                address: "jan@company.example",
                authenticated: true,
            },
            {
                ref: "p2",
                roles: ["to"],
                displayName: null,
                address: "acme-weekly@klepna.example",
                authenticated: false,
            },
            {
                ref: "p3",
                roles: ["quoted_author"],
                displayName: "Eva Buyer",
                address: "eva@client.example",
                authenticated: false,
            },
        ]);
        expect(result.segments[2]?.at?.toISOString().slice(0, 10)).toBe(
            "2026-10-08",
        );
    });

    it("reads a Czech Gmail forward's header block as a forwarded part", () => {
        const result = segmentMail({
            text: null,
            html: fixture("gmail-forward-cs.html"),
            from: JAN,
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(shape(result)).toEqual([
            {
                role: "body",
                depth: 0,
                ref: "p1",
                text: "Přeposílám k vyřízení.",
            },
            {
                role: "quoted",
                depth: 1,
                ref: "p2",
                text: "Dobrý den,\nmůžeme přijmout cenu, pokud dodáte v listopadu.",
            },
            {
                role: "quoted_signature",
                depth: 1,
                ref: "p2",
                text: "S pozdravem\nEva Buyer\nvedoucí nákupu",
            },
        ]);
        expect(result.participants[1]).toMatchObject({
            address: "eva@client.example",
            displayName: "Eva Buyer",
            roles: ["quoted_author"],
        });
        expect(result.segments[1]?.at?.toISOString().slice(0, 16)).toBe(
            "2026-10-08T17:40",
        );
    });

    it("reads an Outlook reply's header block, in Czech, without any markup", () => {
        const result = segmentMail({
            text: fixture("outlook-reply-cs.txt"),
            html: null,
            from: { address: "dvorak@company.example", name: "Karel Dvořák" },
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(shape(result)).toEqual([
            {
                role: "body",
                depth: 0,
                ref: "p1",
                text: "Děkuji, posílám podklady.",
            },
            {
                role: "signature",
                depth: 0,
                ref: "p1",
                text: "S pozdravem\nKarel Dvořák\nObchodní ředitel\nAcme Industries s.r.o.\ntel. +420 777 000 111",
            },
            {
                role: "quoted",
                depth: 1,
                ref: "p2",
                text: "Dobrý den, můžeme přijmout cenu, pokud dodáte v listopadu.\n\nEva Buyer",
            },
        ]);
        expect(result.segments[2]?.at?.toISOString().slice(0, 10)).toBe(
            "2026-10-08",
        );
    });

    it("follows `>` quoting into nested parts", () => {
        const result = segmentMail({
            text: fixture("plain-quoted.txt"),
            html: null,
            from: JAN,
            sentAt: null,
            fromAuthenticated: false,
        });
        expect(shape(result)).toEqual([
            {
                role: "body",
                depth: 0,
                ref: "p1",
                text: "Sounds good, let's do it.",
            },
            {
                role: "quoted",
                depth: 1,
                ref: "p2",
                text: "We can accept the price.",
            },
            {
                role: "quoted",
                depth: 2,
                ref: null,
                text: "Is the price final?\nJan",
            },
        ]);
        expect(result.participants[0]?.authenticated).toBe(false);
    });

    it("splits off a `-- ` signature and a trailing disclaimer", () => {
        const result = segmentMail({
            text: fixture("signature-disclaimer.txt"),
            html: null,
            from: JAN,
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(shape(result).map((s) => [s.role, s.ref])).toEqual([
            ["body", "p1"],
            ["signature", "p1"],
            ["disclaimer", null],
        ]);
        expect(result.segments[1]?.text).toBe("Jan Novotny\nHead of Sales");
    });

    it("reads Apple Mail's attribution in its own blockquote", () => {
        const result = segmentMail({
            text: null,
            html: fixture("apple-reply.html"),
            from: JAN,
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(shape(result)).toEqual([
            { role: "body", depth: 0, ref: "p1", text: "Agreed." },
            {
                role: "quoted",
                depth: 1,
                ref: "p2",
                text: "Shall we meet on Monday?",
            },
        ]);
    });

    it("keeps a mail without quotes or signature as one body", () => {
        const result = segmentMail({
            text: "Just a note.\nSecond line.",
            html: null,
            from: JAN,
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(shape(result)).toEqual([
            {
                role: "body",
                depth: 0,
                ref: "p1",
                text: "Just a note.\nSecond line.",
            },
        ]);
    });

    it("merges one person's roles into one participant", () => {
        const result = segmentMail({
            text: "x",
            html: null,
            from: JAN,
            to: [JAN],
            cc: [{ address: "JAN@company.example", name: "" }],
            sentAt: null,
            fromAuthenticated: true,
        });
        expect(result.participants).toHaveLength(1);
        expect(result.participants[0]?.roles).toEqual(["from", "to", "cc"]);
    });
});

describe("HTML to text", () => {
    it("drops style and script, decodes entities, keeps blocks on lines", () => {
        expect(
            htmlToText(
                "<style>p{color:red}</style><p>A&amp;B&nbsp;&#x2013; &quot;C&quot;</p><script>alert(1)</script><div>D</div>",
            ),
        ).toBe('A&B – "C"\n\nD');
    });
});

describe("claimed dates", () => {
    it("reads the dates reply headers write", () => {
        const day = (text: string) =>
            parseClaimedDate(text)?.toISOString().slice(0, 10) ?? null;
        expect(day("Thu, Oct 8, 2026 at 5:40 PM")).toBe("2026-10-08");
        expect(day("8. 10. 2026 v 17:40")).toBe("2026-10-08");
        expect(day("čtvrtek 8. října 2026 17:40")).toBe("2026-10-08");
        expect(day("whenever")).toBeNull();
    });
});
