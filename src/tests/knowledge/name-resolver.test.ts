import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        DATABASE_URL: "postgres://unused",
    },
}));

vi.mock("../../db", () => ({ db: {} }));

const { encryptText } = await import("../../lib/encryption/fields");
const { emptyNameResolver, namesFromRows } = await import(
    "../../lib/knowledge/attribution"
);
const { renderTurnsAsText } = await import("../../lib/transcription/turns");

const TURNS = [
    { speaker: "speaker_0", startMs: 0, endMs: 1000, text: "Ahoj." },
    { speaker: "speaker_1", startMs: 1000, endMs: 2000, text: "Zdravim." },
];

describe("namesFromRows", () => {
    it("decrypts the stored display name", () => {
        const resolve = namesFromRows([
            { label: "speaker_0", displayName: encryptText("Jan Novotný") },
        ]);

        expect(resolve("speaker_0")).toBe("Jan Novotný");
    });

    it("returns null for a label with no attribution", () => {
        const resolve = namesFromRows([
            { label: "speaker_0", displayName: encryptText("Jan Novotný") },
        ]);

        expect(resolve("speaker_1")).toBeNull();
    });

    it("projects names over turns without touching the raw labels", () => {
        const resolve = namesFromRows([
            { label: "speaker_0", displayName: encryptText("Jan Novotný") },
        ]);

        expect(renderTurnsAsText(TURNS, resolve)).toBe(
            "Jan Novotný: Ahoj.\nspeaker_1: Zdravim.",
        );
        expect(TURNS[0].speaker).toBe("speaker_0");
    });

    it("reads legacy plaintext names", () => {
        const resolve = namesFromRows([
            { label: "speaker_0", displayName: "Jan Novotný" },
        ]);

        expect(resolve("speaker_0")).toBe("Jan Novotný");
    });
});

describe("emptyNameResolver", () => {
    it("leaves every label alone", () => {
        expect(renderTurnsAsText(TURNS, emptyNameResolver())).toBe(
            renderTurnsAsText(TURNS),
        );
    });
});
