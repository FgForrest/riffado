import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));

const { encryptJsonField } = await import("../../lib/encryption/fields");
const { readTranscriptTurns } = await import(
    "../../lib/transcription/read-turns"
);

const turns = [
    { speaker: "speaker_0", startMs: 0, endMs: 1000, text: "Ahoj" },
    { speaker: "speaker_1", startMs: 1000, endMs: 2000, text: "Zdravim" },
];

describe("readTranscriptTurns", () => {
    it("round-trips an encrypted turn array", () => {
        expect(readTranscriptTurns({ turns: encryptJsonField(turns) })).toEqual(
            turns,
        );
    });

    it("returns null for a transcript with no turns", () => {
        expect(readTranscriptTurns({ turns: null })).toBeNull();
        expect(readTranscriptTurns({})).toBeNull();
        expect(readTranscriptTurns(null)).toBeNull();
    });

    it("returns null for an empty stored array", () => {
        expect(readTranscriptTurns({ turns: encryptJsonField([]) })).toBeNull();
    });

    it("passes through a legacy plaintext array", () => {
        expect(readTranscriptTurns({ turns })).toEqual(turns);
    });
});
