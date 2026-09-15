import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { isRetryableError } from "@/lib/jobs/retryable";
import {
    InvalidJobPayloadError,
    type JobHandler,
    type JobResult,
} from "@/lib/jobs/types";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { StorageProvider } from "@/lib/storage/types";
import { saveUploadedAudio } from "./save-uploaded-audio";
import {
    parseVideoExtractionJobPayload,
    VIDEO_EXTRACTION_JOB_KIND,
    VIDEO_EXTRACTION_MAX_ATTEMPTS,
    VIDEO_EXTRACTION_TIMEOUT_MS,
    type VideoExtractionJobPayload,
} from "./video-extraction-job";

interface ProbeResult {
    streams?: Array<{ duration?: string }>;
    format?: { duration?: string };
}

function processError(
    command: string,
    error: unknown,
    signal: AbortSignal,
): Error {
    if (signal.aborted && signal.reason instanceof Error) return signal.reason;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return new AppError(
            ErrorCode.SERVICE_UNAVAILABLE,
            `Video conversion is unavailable because ${command} is not installed`,
            503,
        );
    }
    return error instanceof Error ? error : new Error(String(error));
}

function probeDurationSeconds(
    inputPath: string,
    signal: AbortSignal,
): Promise<number> {
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
            { signal },
        );
        let stdout = "";
        let stderr = "";
        let settled = false;

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.once("error", (error) => {
            if (settled) return;
            settled = true;
            reject(processError("FFmpeg", error, signal));
        });
        child.once("close", (code) => {
            if (settled) return;
            settled = true;
            if (code !== 0) {
                reject(
                    new AppError(
                        ErrorCode.INVALID_FILE_FORMAT,
                        "Video does not contain a readable audio track",
                        422,
                        { ffprobe: stderr.slice(-500) },
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
            } catch {
                reject(
                    new AppError(
                        ErrorCode.INVALID_FILE_FORMAT,
                        "Video does not contain a readable audio track",
                        422,
                    ),
                );
            }
        });
    });
}

function extractAudio(
    inputPath: string,
    outputPath: string,
    durationSeconds: number,
    signal: AbortSignal,
    onProgress: (percent: number) => void,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            "ffmpeg",
            [
                "-nostdin",
                "-y",
                "-i",
                inputPath,
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-progress",
                "pipe:1",
                "-nostats",
                outputPath,
            ],
            { signal },
        );
        let progressBuffer = "";
        let stderr = "";
        let lastPercent = -1;
        let settled = false;

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            progressBuffer += chunk;
            const lines = progressBuffer.split("\n");
            progressBuffer = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.startsWith("out_time_us=")) continue;
                const microseconds = Number(line.slice("out_time_us=".length));
                if (!Number.isFinite(microseconds)) continue;
                const percent = Math.min(
                    99,
                    Math.max(
                        0,
                        Math.floor(
                            (microseconds / 1_000_000 / durationSeconds) * 100,
                        ),
                    ),
                );
                if (percent > lastPercent) {
                    lastPercent = percent;
                    onProgress(percent);
                }
            }
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
            if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
        });
        child.once("error", (error) => {
            if (settled) return;
            settled = true;
            reject(processError("FFmpeg", error, signal));
        });
        child.once("close", (code) => {
            if (settled) return;
            settled = true;
            if (code === 0) {
                onProgress(100);
                resolve();
                return;
            }
            reject(
                new AppError(
                    ErrorCode.INVALID_FILE_FORMAT,
                    "Video could not be converted. Make sure it contains an audio track.",
                    422,
                    { ffmpeg: stderr.slice(-500) },
                ),
            );
        });
    });
}

async function deleteSource(
    storage: StorageProvider,
    sourceStorageKey: string,
): Promise<void> {
    if (await storage.exists(sourceStorageKey)) {
        await storage.deleteFile(sourceStorageKey);
    }
}

export const videoExtractionJobHandler: JobHandler<VideoExtractionJobPayload> =
    {
        kind: VIDEO_EXTRACTION_JOB_KIND,
        concurrency: 1,
        maxAttempts: VIDEO_EXTRACTION_MAX_ATTEMPTS,
        timeoutMs: VIDEO_EXTRACTION_TIMEOUT_MS,
        parsePayload: parseVideoExtractionJobPayload,

        async run({
            payload,
            userId,
            attempt,
            maxAttempts,
            signal,
            reportProgress,
        }): Promise<JobResult> {
            const expectedPrefix = `${userId}/video-uploads/`;
            if (!payload.sourceStorageKey.startsWith(expectedPrefix)) {
                throw new InvalidJobPayloadError(
                    VIDEO_EXTRACTION_JOB_KIND,
                    "sourceStorageKey is not scoped to the job owner",
                );
            }

            const fileId = `uploaded-${payload.uploadId}`;
            const storage = await createUserStorageProvider(userId);
            const [existing] = await db
                .select({ id: recordings.id })
                .from(recordings)
                .where(
                    and(
                        eq(recordings.userId, userId),
                        eq(recordings.plaudFileId, fileId),
                    ),
                )
                .limit(1);

            if (existing) {
                await deleteSource(storage, payload.sourceStorageKey);
                return { converted: true };
            }

            let temporaryDirectory: string | null = null;
            try {
                reportProgress({ phase: "preparing" });
                const source = await storage.downloadFile(
                    payload.sourceStorageKey,
                );
                temporaryDirectory = await mkdtemp(
                    path.join(tmpdir(), "riffado-video-"),
                );
                const filename = decryptText(payload.encryptedFilename);
                const sourceExtension = path.extname(filename).toLowerCase();
                const inputPath = path.join(temporaryDirectory, "input");
                const outputPath = path.join(temporaryDirectory, "audio.m4a");
                await writeFile(inputPath, source);

                const durationSeconds = await probeDurationSeconds(
                    inputPath,
                    signal,
                );
                reportProgress({
                    phase: "extracting",
                    completed: 0,
                    total: 100,
                });
                await extractAudio(
                    inputPath,
                    outputPath,
                    durationSeconds,
                    signal,
                    (percent) =>
                        reportProgress({
                            phase: "extracting",
                            completed: percent,
                            total: 100,
                        }),
                );

                reportProgress({ phase: "saving" });
                const audio = await readFile(outputPath);
                const basename = path.basename(
                    filename,
                    path.extname(filename),
                );
                const saved = await saveUploadedAudio({
                    userId,
                    fileId,
                    basename,
                    extension: ".m4a",
                    buffer: audio,
                    storage,
                    sourceExtension,
                    convertedFromVideo: true,
                });

                await deleteSource(storage, payload.sourceStorageKey);
                return {
                    converted: true,
                    durationMs: saved.durationMs,
                    filesize: saved.filesize,
                };
            } catch (error) {
                const willRetry =
                    attempt < maxAttempts && isRetryableError(error);
                if (!willRetry) {
                    await deleteSource(storage, payload.sourceStorageKey);
                }
                throw error;
            } finally {
                if (temporaryDirectory) {
                    await rm(temporaryDirectory, {
                        recursive: true,
                        force: true,
                    });
                }
            }
        },
    };
