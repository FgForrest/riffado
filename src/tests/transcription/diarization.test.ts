/**
 * The dialog view is gated twice, and both gates matter.
 *
 * `mayBeDiarized` asks whether this transcript came from a path that emits
 * speaker labels at all. Without it, a Gemini transcript containing a line
 * like "Note: remember to send the deck" would be rendered as a speaker
 * called "Note". `parseSpeakerTurns` then asks whether labels actually
 * arrived, because a diarizing model can still answer with one unlabelled
 * block -- `formatDiarizedText` returns null in that case and the caller
 * stores plain prose under a `+diarize` model name.
 */

import { describe, expect, it } from "vitest";
import {
    formatSpeakerLabel,
    mayBeDiarized,
    parseSpeakerTurns,
    speakerOrder,
} from "@/lib/transcription/diarization";

describe("mayBeDiarized", () => {
    it("accepts the models that are asked to diarize", () => {
        // The same `diarize` substring `getResponseFormat` keys on, so the
        // display rule cannot drift from the request rule.
        expect(
            mayBeDiarized({
                source: "riffado",
                model: "gpt-4o-transcribe-diarize",
            }),
        ).toBe(true);
        expect(
            mayBeDiarized({ source: "riffado", model: "scribe_v2+diarize" }),
        ).toBe(true);
    });

    it("accepts Plaud-imported transcripts, which arrive as speaker segments", () => {
        expect(mayBeDiarized({ source: "plaud", model: "plaud" })).toBe(true);
        expect(mayBeDiarized({ source: "mixed", model: "whisper-1" })).toBe(
            true,
        );
    });

    it("rejects the providers prompted for no speaker labels", () => {
        expect(
            mayBeDiarized({ source: "riffado", model: "gemini-2.0-flash" }),
        ).toBe(false);
        expect(mayBeDiarized({ source: "riffado", model: "whisper-1" })).toBe(
            false,
        );
        expect(mayBeDiarized({ source: "riffado", model: "scribe_v2" })).toBe(
            false,
        );
        expect(mayBeDiarized({ source: "riffado", model: "parakeet" })).toBe(
            false,
        );
    });

    it("rejects a row with nothing recorded on it", () => {
        expect(mayBeDiarized({})).toBe(false);
        expect(mayBeDiarized({ source: null, model: null })).toBe(false);
    });
});

describe("parseSpeakerTurns", () => {
    it("splits the ElevenLabs shape", () => {
        const turns = parseSpeakerTurns(
            "speaker_0: Welcome everyone.\nspeaker_1: Thanks for having me.",
        );
        expect(turns).toEqual([
            {
                speaker: "speaker_0",
                label: "Speaker 0",
                text: "Welcome everyone.",
            },
            {
                speaker: "speaker_1",
                label: "Speaker 1",
                text: "Thanks for having me.",
            },
        ]);
    });

    it("splits the Plaud shape", () => {
        const turns = parseSpeakerTurns(
            "Speaker 0: First point.\nSpeaker 1: Second point.",
        );
        expect(turns?.map((t) => t.label)).toEqual(["Speaker 0", "Speaker 1"]);
    });

    it("groups consecutive turns from one speaker", () => {
        const turns = parseSpeakerTurns(
            "A: One.\nA: Two.\nB: Three.\nA: Four.",
        );
        expect(turns).toHaveLength(3);
        expect(turns?.[0]).toMatchObject({ speaker: "A", text: "One.\nTwo." });
        expect(turns?.[2]).toMatchObject({ speaker: "A", text: "Four." });
    });

    it("returns null when nothing is labelled", () => {
        expect(
            parseSpeakerTurns("Just a plain transcript with no labels at all."),
        ).toBeNull();
    });

    it("returns null when labels are the exception rather than the rule", () => {
        // A diarized row whose text was edited down to prose, with one
        // stray colon left in it. Rendering that as a dialog would invent a
        // speaker called "Note".
        const text = [
            "This is a long stretch of ordinary prose.",
            "It carries on for several lines without any labels.",
            "Note: this line happens to contain a colon.",
            "And then it continues as prose again.",
        ].join("\n");
        expect(parseSpeakerTurns(text)).toBeNull();
    });

    it("keeps an unlabelled continuation with the turn above it", () => {
        const turns = parseSpeakerTurns(
            "speaker_0: First line.\na wrapped continuation\nspeaker_1: Reply.",
        );
        expect(turns).toHaveLength(2);
        expect(turns?.[0].text).toBe("First line.\na wrapped continuation");
    });

    it("ignores blank lines", () => {
        const turns = parseSpeakerTurns(
            "speaker_0: One.\n\n\nspeaker_1: Two.\n",
        );
        expect(turns).toHaveLength(2);
    });

    it("does not treat a long sentence prefix as a label", () => {
        const text = [
            "speaker_0: A real turn.",
            "In conclusion and after considerable deliberation by everyone: we agreed.",
        ].join("\n");
        const turns = parseSpeakerTurns(text);
        // Second line is too long to be a label, so it folds into the turn.
        expect(turns).toHaveLength(1);
        expect(turns?.[0].speaker).toBe("speaker_0");
    });

    it("requires whitespace after the colon", () => {
        // `12:30 we started` is a timestamp, not Speaker "12".
        expect(parseSpeakerTurns("12:30 we started the meeting")).toBeNull();
    });
});

describe("formatSpeakerLabel", () => {
    it("makes stored labels readable without renaming them", () => {
        // Summaries quote these back verbatim, so the display form has to
        // stay recognisably the same speaker.
        expect(formatSpeakerLabel("speaker_0")).toBe("Speaker 0");
        expect(formatSpeakerLabel("SPEAKER_2")).toBe("Speaker 2");
        expect(formatSpeakerLabel("Speaker 1")).toBe("Speaker 1");
    });

    it("leaves a human name alone", () => {
        expect(formatSpeakerLabel("Jana")).toBe("Jana");
        expect(formatSpeakerLabel("A")).toBe("A");
    });

    it("is empty for an empty label", () => {
        expect(formatSpeakerLabel("")).toBe("");
        expect(formatSpeakerLabel("   ")).toBe("");
    });
});

describe("speakerOrder", () => {
    it("orders by first appearance, not by label", () => {
        const turns = parseSpeakerTurns("zoe: hello\nadam: hi\nzoe: again");
        expect(speakerOrder(turns ?? [])).toEqual(["zoe", "adam"]);
    });

    it("skips unlabelled turns", () => {
        const turns = [
            { speaker: "", label: "", text: "preamble" },
            { speaker: "a", label: "A", text: "hi" },
        ];
        expect(speakerOrder(turns)).toEqual(["a"]);
    });
});
