import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/env", () => ({
    env: {
        API_TOKEN_HASH_SECRET: "test-lookup-secret",
        BETTER_AUTH_SECRET: "fallback-secret",
    },
}));

const { lookupHash, normalizeForLookup } = await import(
    "../../lib/knowledge/lookup-hash"
);

describe("normalizeForLookup", () => {
    it("folds case and surrounding whitespace", () => {
        expect(normalizeForLookup("  Jan.Novotny@FG.cz ")).toBe(
            "jan.novotny@fg.cz",
        );
    });
});

describe("lookupHash", () => {
    it("is stable for the same value", () => {
        expect(lookupHash("jan@fg.cz")).toBe(lookupHash("jan@fg.cz"));
    });

    it("ignores case and whitespace so one person is not created twice", () => {
        expect(lookupHash("  JAN@FG.CZ ")).toBe(lookupHash("jan@fg.cz"));
    });

    it("differs for different values", () => {
        expect(lookupHash("jan@fg.cz")).not.toBe(lookupHash("petr@fg.cz"));
    });

    it("does not return the plaintext", () => {
        const hash = lookupHash("jan@fg.cz");
        expect(hash).not.toContain("jan");
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
});
