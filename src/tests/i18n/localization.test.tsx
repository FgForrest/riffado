import { parse } from "@formatjs/icu-messageformat-parser";
import { describe, expect, it } from "vitest";
import { localeFromAcceptLanguage, normalizeLocale } from "@/lib/i18n/config";
import { createEmailTranslator } from "@/lib/i18n/email-messages";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import csCzMessages from "../../../messages/cs-CZ.json";
import csCzEmailMessages from "../../../messages/email/cs-CZ.json";
import enEmailMessages from "../../../messages/email/en.json";
import enMessages from "../../../messages/en.json";

function sortedKeys(value: Record<string, string>) {
    return Object.keys(value).sort();
}

function validateCatalog(catalog: Record<string, string>) {
    for (const [key, message] of Object.entries(catalog)) {
        expect(message.trim(), key).not.toBe("");
        expect(() => parse(message), key).not.toThrow();
    }
}

describe("locale selection", () => {
    it.each([
        ["cs", "cs-CZ"],
        ["cs_CZ", "cs-CZ"],
        ["cs-SK", "cs-CZ"],
        ["en", "en"],
        ["en-US", "en"],
        ["de-DE", null],
        [null, null],
    ] as const)("normalizes %s", (input, expected) => {
        expect(normalizeLocale(input)).toBe(expected);
    });

    it("honors Accept-Language quality and source order", () => {
        expect(localeFromAcceptLanguage("en-US;q=0.7, cs-CZ;q=0.9")).toBe(
            "cs-CZ",
        );
        expect(localeFromAcceptLanguage("cs;q=0.8, en;q=0.8")).toBe("cs-CZ");
        expect(localeFromAcceptLanguage("de, en;q=0.5")).toBe("en");
        expect(localeFromAcceptLanguage("cs;q=0, en;q=0.4")).toBe("en");
    });
});

describe("message catalogs", () => {
    it("keeps the application catalogs complete and valid", () => {
        expect(sortedKeys(csCzMessages)).toEqual(sortedKeys(enMessages));
        validateCatalog(enMessages);
        validateCatalog(csCzMessages);
    });

    it("keeps the semantic email catalogs complete and valid", () => {
        expect(sortedKeys(csCzEmailMessages)).toEqual(
            sortedKeys(enEmailMessages),
        );
        validateCatalog(enEmailMessages);
        validateCatalog(csCzEmailMessages);
    });
});

describe("localized email content", () => {
    it("resolves extracted template copy in English and Czech", () => {
        expect(translatedSourceMessage("en", "Test email")).toBe("Test email");
        expect(translatedSourceMessage("cs-CZ", "Test email")).toBe(
            "Testovací e-mail",
        );
    });

    it("resolves semantic email subjects in Czech", () => {
        const email = createEmailTranslator("cs-CZ");
        expect(email("test")).toBe("Testovací e-mail z Riffado");
    });
});
