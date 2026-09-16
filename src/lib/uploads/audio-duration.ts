import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseBuffer } from "music-metadata";

const FFPROBE_TIMEOUT_MS = 15_000;
const MAX_PROCESS_OUTPUT_LENGTH = 16_384;

interface ProbeResult {
    streams?: Array<{ duration?: string }>;
    format?: { duration?: string };
}

function probeDurationSeconds(inputPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            "ffprobe",
            [
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=duration:format=duration",
                "-of",
                "json",
                inputPath,
            ],
            { signal: AbortSignal.timeout(FFPROBE_TIMEOUT_MS) },
        );
        let stdout = "";
        let stderr = "";
        let settled = false;

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout = (stdout + chunk).slice(-MAX_PROCESS_OUTPUT_LENGTH);
        });
        child.stderr.on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(-MAX_PROCESS_OUTPUT_LENGTH);
        });
        child.once("error", (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        });
        child.once("close", (code) => {
            if (settled) return;
            settled = true;
            if (code !== 0) {
                reject(
                    new Error(
                        `FFprobe exited with code ${code}: ${stderr.slice(-500)}`,
                    ),
                );
                return;
            }

            try {
                const result = JSON.parse(stdout) as ProbeResult;
                const streamDuration = result.streams?.[0]?.duration;
                const duration = Number(
                    streamDuration && streamDuration !== "N/A"
                        ? streamDuration
                        : result.format?.duration,
                );
                if (!result.streams?.length || !(duration > 0)) {
                    throw new Error("No timed audio stream");
                }
                resolve(duration);
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function probeBufferDurationMs(buffer: Uint8Array): Promise<number> {
    const temporaryDirectory = await mkdtemp(
        path.join(tmpdir(), "riffado-audio-probe-"),
    );
    try {
        const inputPath = path.join(temporaryDirectory, "input");
        await writeFile(inputPath, buffer);
        const seconds = await probeDurationSeconds(inputPath);
        return Number.isFinite(seconds) && seconds > 0
            ? Math.round(seconds * 1000)
            : 0;
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
}

/** Read audio duration, using FFprobe only for containers the JS parser cannot time. */
export async function readAudioDurationMs(
    buffer: Uint8Array,
    mimeType: string,
): Promise<number> {
    let metadataError: unknown;
    try {
        const { format } = await parseBuffer(
            buffer,
            { mimeType, size: buffer.byteLength },
            { duration: true },
        );
        const seconds = format.duration ?? 0;
        if (seconds > 0) return Math.round(seconds * 1000);
    } catch (error) {
        metadataError = error;
    }

    try {
        return await probeBufferDurationMs(buffer);
    } catch (probeError) {
        console.error(
            "Audio duration detection failed:",
            metadataError ?? probeError,
        );
        return 0;
    }
}
