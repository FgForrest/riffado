import { describe, expect, it } from "vitest";
import { pcm16Peaks } from "@/lib/audio/server-waveform";

describe("server waveform generation", () => {
    it("normalizes signed PCM into the requested peak buckets", () => {
        const pcm = Buffer.alloc(16);
        [-100, 200, -1_000, 500, 2_000, -500, 4_000, -2_000].forEach(
            (sample, index) => {
                pcm.writeInt16LE(sample, index * 2);
            },
        );

        expect(pcm16Peaks(pcm, 4)).toEqual([0.05, 0.25, 0.5, 1]);
    });

    it("rejects empty decoder output", () => {
        expect(() => pcm16Peaks(Buffer.alloc(0), 500)).toThrow(
            "Decoded audio contains no samples",
        );
    });
});
