import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        DATABASE_URL: "postgres://unused",
    },
}));

vi.mock("../../db", () => ({ db: {} }));

const { encryptJsonField, encryptText } = await import(
    "../../lib/encryption/fields"
);
const { projectTranscript, resolverMapFromRows } = await import(
    "../../lib/knowledge/project-transcript"
);

const TURNS = [
    { speaker: "speaker_0", startMs: 0, endMs: 1000, text: "Ahoj." },
    { speaker: "speaker_1", startMs: 1000, endMs: 2000, text: "Zdravim." },
];

const RAW_TEXT = "speaker_0: Ahoj.\nspeaker_1: Zdravim.";

const jan = () => (speaker: string) =>
    speaker === "speaker_0" ? "Jan Novotný" : null;

describe("projectTranscript", () => {
    it("applies names over the stored turns", () => {
        expect(
            projectTranscript(
                { id: "t1", text: RAW_TEXT, turns: encryptJsonField(TURNS) },
                jan(),
            ),
        ).toBe("Jan Novotný: Ahoj.\nspeaker_1: Zdravim.");
    });

    it("falls back to the stored text when there are no turns", () => {
        expect(projectTranscript({ id: "t1", text: RAW_TEXT }, jan())).toBe(
            RAW_TEXT,
        );
    });

    it("falls back to the stored text when there is no resolver", () => {
        expect(
            projectTranscript(
                { id: "t1", text: RAW_TEXT, turns: encryptJsonField(TURNS) },
                undefined,
            ),
        ).toBe(RAW_TEXT);
    });

    it("leaves an unattributed transcript byte-identical", () => {
        expect(
            projectTranscript(
                { id: "t1", text: RAW_TEXT, turns: encryptJsonField(TURNS) },
                () => null,
            ),
        ).toBe(RAW_TEXT);
    });
});

describe("resolverMapFromRows", () => {
    it("groups labels by transcript", () => {
        const map = resolverMapFromRows([
            {
                transcriptionId: "t1",
                label: "speaker_0",
                displayName: encryptText("Jan Novotný"),
            },
            {
                transcriptionId: "t1",
                label: "speaker_1",
                displayName: encryptText("Petr Málek"),
            },
            {
                transcriptionId: "t2",
                label: "speaker_0",
                displayName: encryptText("Jana Dvořáková"),
            },
        ]);

        expect(map.get("t1")?.("speaker_0")).toBe("Jan Novotný");
        expect(map.get("t1")?.("speaker_1")).toBe("Petr Málek");
        expect(map.get("t2")?.("speaker_0")).toBe("Jana Dvořáková");
        expect(map.get("t2")?.("speaker_1")).toBeNull();
    });

    it("does not leak a name across transcripts", () => {
        const map = resolverMapFromRows([
            {
                transcriptionId: "t1",
                label: "speaker_0",
                displayName: encryptText("Jan Novotný"),
            },
        ]);

        expect(map.get("t2")).toBeUndefined();
    });

    it("returns an empty map for no rows", () => {
        expect(resolverMapFromRows([]).size).toBe(0);
    });
});
