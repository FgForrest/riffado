/**
 * The dialog view shipped working on the recording detail page and silently
 * inert on the dashboard.
 *
 * `TranscriptView` decides whether a transcript was diarized from its `source`
 * and `model`. The recording detail page selects both and passes them through
 * `transcripts`. The dashboard did neither: its query fetched only
 * `recordingId`, `text` and `language`, and `TranscriptionPanel`'s
 * single-transcript path then invented `source: "riffado"` with no model at
 * all -- so every dashboard transcript, however thoroughly diarized, failed
 * the first gate and rendered as plain text.
 *
 * Nothing failed. There was no error to see: the fallback is the correct
 * behaviour for an undiarized transcript, so a missing model is
 * indistinguishable from an honest "this one has no speakers".
 */

import { describe, expect, it } from "vitest";
import { toTranscriptList } from "@/components/dashboard/transcription-panel";
import { mayBeDiarized } from "@/lib/transcription/diarization";

const DIARIZED_TEXT = "speaker_0: Hello.\nspeaker_1: Hi.";

describe("transcript provenance survives the single-transcript path", () => {
    it("carries source and model through", () => {
        const [option] = toTranscriptList(undefined, {
            text: DIARIZED_TEXT,
            language: "ces",
            source: "riffado",
            model: "scribe_v2+diarize",
        });
        expect(option).toMatchObject({
            source: "riffado",
            model: "scribe_v2+diarize",
        });
    });

    it("leaves a diarized transcript recognisable as diarized", () => {
        // The end-to-end invariant, stated as one expression: what the panel
        // builds has to satisfy the gate the view applies to it.
        const [option] = toTranscriptList(undefined, {
            text: DIARIZED_TEXT,
            source: "riffado",
            model: "scribe_v2+diarize",
        });
        expect(mayBeDiarized(option)).toBe(true);
    });

    it("still defaults the source when a caller genuinely has none", () => {
        const [option] = toTranscriptList(undefined, { text: "plain text" });
        expect(option.source).toBe("riffado");
        expect(mayBeDiarized(option)).toBe(false);
    });

    it("prefers the multi-transcript prop when both are supplied", () => {
        const list = toTranscriptList(
            [{ source: "plaud", text: "from plaud", model: "plaud" }],
            { text: "back-compat", source: "riffado", model: "whisper-1" },
        );
        expect(list).toHaveLength(1);
        expect(list[0].source).toBe("plaud");
    });

    it("is empty when there is no transcript at all", () => {
        expect(toTranscriptList(undefined, undefined)).toEqual([]);
        expect(toTranscriptList([], { text: "" })).toEqual([]);
    });
});
