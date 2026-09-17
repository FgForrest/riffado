import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/audio/server-waveform", () => ({
    generateServerWaveform: vi.fn(),
}));

import { generateIngestWaveform } from "@/lib/audio/ingest-waveform";
import { generateServerWaveform } from "@/lib/audio/server-waveform";

describe("ingest waveform generation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("generates the standard persisted waveform", async () => {
        const audio = Buffer.from("audio");
        const peaks = Array.from({ length: 500 }, (_, index) => index / 500);
        (generateServerWaveform as Mock).mockResolvedValue(peaks);

        await expect(generateIngestWaveform(audio)).resolves.toBe(peaks);
        expect(generateServerWaveform).toHaveBeenCalledWith(audio, 500);
    });

    it("does not fail ingestion when waveform decoding fails", async () => {
        const error = new Error("unsupported codec");
        (generateServerWaveform as Mock).mockRejectedValue(error);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(
            generateIngestWaveform(Buffer.from("audio")),
        ).resolves.toBeNull();
        expect(warn).toHaveBeenCalledWith(
            "Waveform generation failed during audio ingest:",
            error,
        );

        warn.mockRestore();
    });
});
