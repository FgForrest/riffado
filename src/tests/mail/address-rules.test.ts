import { describe, expect, it } from "vitest";
import {
    aliasSegment,
    folderAddressCandidates,
    isAcceptableLocalPart,
    MAX_LOCAL_PART,
    mailboxNameCandidates,
    manualFolderAddress,
    normalizeNickname,
    normalizeRecipientLocalPart,
    secretLocalPart,
    secretToken,
} from "@/lib/mail/address-rules";

function take<T>(generator: Generator<T>, n: number): T[] {
    const out: T[] = [];
    for (const value of generator) {
        out.push(value);
        if (out.length === n) break;
    }
    return out;
}

describe("mailbox names", () => {
    it("takes the verified email's local part, made safe", () => {
        expect(
            take(
                mailboxNameCandidates("Jan.Novotny@company.example", ["acme"]),
                1,
            ),
        ).toEqual(["jan.novotny"]);
    });

    it("transliterates letters NFKD does not decompose", () => {
        const name = (email: string) =>
            take(mailboxNameCandidates(email, ["acme"]), 1)[0];
        expect(name("Jiří.Dvořák@company.example")).toBe("jiri.dvorak");
        expect(name("straße@company.example")).toBe("strasse");
        expect(name("łukasz.økland@company.example")).toBe("lukasz.okland");
        expect(name("ærøskøbing@company.example")).toBe("aeroskobing");
        expect(name("đorđe@company.example")).toBe("dorde");
    });

    it("drops what an address may not hold, collapses runs and trims the ends", () => {
        const name = (email: string) =>
            take(mailboxNameCandidates(email, ["acme"]), 1)[0];
        expect(name("jan+tag@company.example")).toBe("jantag");
        expect(name("..jan__..novotny--@company.example")).toBe("jan.novotny");
        expect(name("!!!@company.example")).toBe("user");
    });

    it("keeps at most 40 characters", () => {
        const [name] = take(
            mailboxNameCandidates(`${"a".repeat(60)}@company.example`, [
                "acme",
            ]),
            1,
        );
        expect(name).toHaveLength(40);
    });

    it("numbers a taken name within the limit", () => {
        expect(
            take(mailboxNameCandidates("jan@company.example", ["acme"]), 3),
        ).toEqual(["jan", "jan2", "jan3"]);
        const long = take(
            mailboxNameCandidates(`${"b".repeat(45)}@company.example`, [
                "acme",
            ]),
            2,
        );
        expect(long[1]).toBe(`${"b".repeat(39)}2`);
    });

    it("never takes a reserved name or a nickname, current or former", () => {
        expect(
            take(
                mailboxNameCandidates("postmaster@company.example", ["acme"]),
                1,
            ),
        ).toEqual(["postmaster2"]);
        expect(
            take(
                mailboxNameCandidates("acme@company.example", ["acme", "old"]),
                1,
            ),
        ).toEqual(["acme2"]);
        expect(
            take(
                mailboxNameCandidates("old@company.example", ["acme", "old"]),
                1,
            ),
        ).toEqual(["old2"]);
    });

    it("keeps out of the Organization's namespace", () => {
        expect(
            take(
                mailboxNameCandidates("acme-team@company.example", ["acme"]),
                1,
            ),
        ).toEqual(["acmeteam"]);
    });
});

describe("folder addresses", () => {
    it("tries the last segment, then longer tails of the path", () => {
        expect(
            take(
                folderAddressCandidates("novotny+", [
                    "Private",
                    "Meetings",
                    "Weekly",
                ]),
                4,
            ),
        ).toEqual([
            "novotny+weekly",
            "novotny+meetingsweekly",
            "novotny+privatemeetingsweekly",
            "novotny+privatemeetingsweekly2",
        ]);
    });

    it("joins segments without a separator and slugs them", () => {
        expect(
            take(
                folderAddressCandidates("acme-", [
                    "One-to-ones",
                    "Týdenní porada",
                ]),
                2,
            ),
        ).toEqual(["acme-tydenniporada", "acme-one-to-onestydenniporada"]);
    });

    it("names an empty segment `folder`", () => {
        expect(take(folderAddressCandidates("acme-", ["!!!"]), 1)).toEqual([
            "acme-folder",
        ]);
    });

    it("leaves room for a secret address's suffix", () => {
        const prefix = `${"n".repeat(30)}+`;
        for (const candidate of take(
            folderAddressCandidates(prefix, ["x".repeat(80), "y".repeat(80)]),
            5,
        )) {
            expect(candidate.length + 11).toBeLessThanOrEqual(MAX_LOCAL_PART);
            expect(isAcceptableLocalPart(candidate)).toBe(true);
        }
    });

    it("refuses a manual alias with nothing usable or too long", () => {
        expect(manualFolderAddress("acme-", "Weekly sync")).toBe(
            "acme-weeklysync",
        );
        expect(manualFolderAddress("acme-", "!!!")).toBeNull();
        expect(manualFolderAddress("acme-", "z".repeat(80))).toBeNull();
        expect(manualFolderAddress("acme-", "folder")).toBe("acme-folder");
    });
});

describe("secret addresses", () => {
    it("adds a dot and a 10-character base32 token", () => {
        const token = secretToken();
        expect(token).toMatch(/^[a-z2-7]{10}$/);
        expect(secretLocalPart("novotny+weekly", "abcdefghij")).toBe(
            "novotny+weekly.abcdefghij",
        );
    });

    it("draws a different token each time", () => {
        const tokens = new Set(
            Array.from({ length: 200 }, () => secretToken()),
        );
        expect(tokens.size).toBe(200);
    });
});

describe("recipients", () => {
    it("accepts ASCII local parts only, compared lowercase", () => {
        expect(normalizeRecipientLocalPart("Novotny+Weekly")).toBe(
            "novotny+weekly",
        );
        expect(normalizeRecipientLocalPart('"quoted"')).toBeNull();
        expect(normalizeRecipientLocalPart("jiří")).toBeNull();
        expect(normalizeRecipientLocalPart("a..b")).toBeNull();
        expect(normalizeRecipientLocalPart("x".repeat(65))).toBeNull();
    });

    it("normalizes a nickname to letters and digits", () => {
        expect(normalizeNickname("ACME")).toBe("acme");
        expect(normalizeNickname("a-c_m e")).toBe("acme");
        expect(normalizeNickname("")).toBe("org");
        expect(aliasSegment("---")).toBe("folder");
    });
});
