import { describe, expect, it } from "vitest";
import {
    getResponseFormat,
    parseTranscriptionResponse,
} from "@/lib/transcription/format";
import { expectTextAndTurnsAgree } from "./turns-parity";

describe("getResponseFormat", () => {
    it("picks the diarized format for a model carrying the diarize flag", () => {
        expect(getResponseFormat("gpt-4o-transcribe-diarize")).toBe(
            "diarized_json",
        );
        expect(getResponseFormat("gpt-4o-transcribe")).toBe("json");
        expect(getResponseFormat("whisper-1")).toBe("verbose_json");
    });
});

describe("parseTranscriptionResponse", () => {
    const diarized = {
        segments: [
            { id: "1", speaker: "A", start: 0, end: 1.5, text: "Ahoj." },
            { id: "2", speaker: "B", start: 1.5, end: 3, text: "Zdravim." },
            { id: "3", speaker: "A", start: 3, end: 4.25, text: "Zacneme." },
        ],
    };

    it("returns turns with millisecond timings for a diarized response", () => {
        const parsed = parseTranscriptionResponse(diarized, "diarized_json");

        expect(parsed.turns).toEqual([
            { speaker: "A", startMs: 0, endMs: 1500, text: "Ahoj." },
            { speaker: "B", startMs: 1500, endMs: 3000, text: "Zdravim." },
            { speaker: "A", startMs: 3000, endMs: 4250, text: "Zacneme." },
        ]);
    });

    it("renders text and turns consistently when speakers alternate", () => {
        const parsed = parseTranscriptionResponse(diarized, "diarized_json");
        expectTextAndTurnsAgree(parsed.text, parsed.turns);
    });

    it("renders text and turns consistently across a same-speaker run", () => {
        const parsed = parseTranscriptionResponse(
            {
                segments: [
                    { id: "1", speaker: "A", start: 0, end: 1, text: "one" },
                    { id: "2", speaker: "A", start: 1, end: 2, text: "two" },
                ],
            },
            "diarized_json",
        );

        expectTextAndTurnsAgree(parsed.text, parsed.turns);
    });

    it("renders text and turns consistently when a segment is blank", () => {
        const parsed = parseTranscriptionResponse(
            {
                segments: [
                    { id: "1", speaker: "A", start: 0, end: 1, text: "hi" },
                    { id: "2", speaker: "B", start: 1, end: 2, text: "   " },
                ],
            },
            "diarized_json",
        );

        expectTextAndTurnsAgree(parsed.text, parsed.turns);
    });

    it("renders text and turns consistently when a segment is padded", () => {
        const parsed = parseTranscriptionResponse(
            {
                segments: [
                    {
                        id: "1",
                        speaker: "A",
                        start: 0,
                        end: 1,
                        text: "  padded  ",
                    },
                ],
            },
            "diarized_json",
        );

        expectTextAndTurnsAgree(parsed.text, parsed.turns);
    });

    it("returns no turns for a diarized response with no segments", () => {
        expect(
            parseTranscriptionResponse({ segments: [] }, "diarized_json").turns,
        ).toBeUndefined();
    });

    it("returns no turns for the undiarized formats", () => {
        expect(
            parseTranscriptionResponse(
                { text: "Ahoj", language: "cs" },
                "verbose_json",
            ).turns,
        ).toBeUndefined();
        expect(
            parseTranscriptionResponse({ text: "Ahoj" }, "json").turns,
        ).toBeUndefined();
    });

    it("still reports the detected language for verbose responses", () => {
        expect(
            parseTranscriptionResponse(
                { text: "Ahoj", language: "cs" },
                "verbose_json",
            ),
        ).toEqual({ text: "Ahoj", detectedLanguage: "cs" });
    });
});
