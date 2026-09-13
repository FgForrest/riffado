/**
 * Stored turns have to survive the same two hops that `source` and `model`
 * once failed (see `transcript-provenance-reaches-view.test.ts`).
 *
 * There are two independent SSR loaders that decrypt transcript text --
 * `app/(app)/dashboard/page.tsx` and `app/(app)/recordings/[id]/page.tsx` --
 * and both feed the same `TranscriptView`. A loader that selects `turns` but
 * does not pass it, or passes it but does not select it, degrades silently:
 * the regex fallback still produces a readable dialog, so nothing errors and
 * nothing looks wrong. The only visible difference is that the turns carry
 * timings and the regex cannot, which is exactly what the knowledge base
 * needs and exactly what nobody would notice missing.
 */

import { describe, expect, it } from "vitest";
import { toTranscriptList } from "@/components/dashboard/transcription-panel";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const TURNS: TranscriptTurn[] = [
    { speaker: "speaker_0", startMs: 0, endMs: 1500, text: "Ahoj." },
    { speaker: "speaker_1", startMs: 1500, endMs: 3000, text: "Zdravím." },
];

const DIARIZED_TEXT = "speaker_0: Ahoj.\nspeaker_1: Zdravím.";

describe("stored turns survive the single-transcript path", () => {
    it("carries turns through toTranscriptList", () => {
        const [option] = toTranscriptList(undefined, {
            text: DIARIZED_TEXT,
            language: "ces",
            source: "riffado",
            model: "scribe_v2+diarize",
            turns: TURNS,
        });

        expect(option.turns).toEqual(TURNS);
    });

    it("leaves turns absent for a transcript that has none", () => {
        const [option] = toTranscriptList(undefined, {
            text: "Plain prose with no speakers.",
            source: "riffado",
            model: "whisper-1",
        });

        expect(option.turns).toBeUndefined();
    });

    it("prefers the explicit transcripts list when one is given", () => {
        const [option] = toTranscriptList(
            [
                {
                    source: "plaud",
                    text: DIARIZED_TEXT,
                    model: "plaud-native",
                    turns: TURNS,
                },
            ],
            undefined,
        );

        expect(option.turns).toEqual(TURNS);
    });
});
