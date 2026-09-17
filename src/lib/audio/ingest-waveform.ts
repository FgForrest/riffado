import { generateServerWaveform } from "@/lib/audio/server-waveform";
import { DEFAULT_BUCKETS } from "@/lib/audio/waveform";

/** Generate persisted waveform peaks without making audio ingestion fail. */
export async function generateIngestWaveform(
    input: Buffer,
): Promise<number[] | null> {
    try {
        return await generateServerWaveform(input, DEFAULT_BUCKETS);
    } catch (error) {
        console.warn("Waveform generation failed during audio ingest:", error);
        return null;
    }
}
