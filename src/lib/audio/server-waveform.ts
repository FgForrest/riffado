import { runFfmpeg } from "@/lib/transcription/ffmpeg";

const WAVEFORM_SAMPLE_RATE = 1_000;

/** Build normalized waveform buckets from signed 16-bit mono PCM. */
export function pcm16Peaks(pcm: Buffer, buckets: number): number[] {
    if (buckets < 1) throw new Error("buckets must be positive");

    const sampleCount = Math.floor(pcm.length / 2);
    if (sampleCount === 0) throw new Error("Decoded audio contains no samples");

    const peaks = new Array<number>(buckets).fill(0);
    let maxPeak = 0;

    for (let bucket = 0; bucket < buckets; bucket++) {
        const start = Math.floor((bucket * sampleCount) / buckets);
        const end = Math.max(
            start + 1,
            Math.floor(((bucket + 1) * sampleCount) / buckets),
        );
        let peak = 0;

        for (
            let sample = start;
            sample < Math.min(end, sampleCount);
            sample++
        ) {
            const value = Math.abs(pcm.readInt16LE(sample * 2));
            if (value > peak) peak = value;
        }

        peaks[bucket] = peak;
        if (peak > maxPeak) maxPeak = peak;
    }

    if (maxPeak === 0) return peaks;
    return peaks.map((peak) => Math.round((peak / maxPeak) * 1_000) / 1_000);
}

/** Decode any FFmpeg-supported audio container into a compact waveform. */
export async function generateServerWaveform(
    input: Buffer,
    buckets: number,
): Promise<number[]> {
    const pcm = await runFfmpeg(input, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(WAVEFORM_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
    ]);
    return pcm16Peaks(pcm, buckets);
}
