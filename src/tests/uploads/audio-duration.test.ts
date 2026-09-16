import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { parseBufferMock, spawnMock } = vi.hoisted(() => ({
    parseBufferMock: vi.fn(),
    spawnMock: vi.fn(),
}));

vi.mock("music-metadata", () => ({ parseBuffer: parseBufferMock }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { readAudioDurationMs } from "@/lib/uploads/audio-duration";

function ffprobeProcess(result: unknown) {
    const process = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
    };
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    queueMicrotask(() => {
        process.stdout.end(JSON.stringify(result));
        process.emit("close", 0);
    });
    return process;
}

describe("readAudioDurationMs", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("uses music-metadata without invoking FFprobe for ordinary audio", async () => {
        parseBufferMock.mockResolvedValue({ format: { duration: 1.25 } });

        await expect(
            readAudioDurationMs(Buffer.from("audio"), "audio/mpeg"),
        ).resolves.toBe(1250);
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it("falls back to the first FFprobe audio stream for multiplexed Ogg", async () => {
        parseBufferMock.mockResolvedValue({ format: {} });
        spawnMock.mockImplementation(() =>
            ffprobeProcess({
                streams: [{ duration: "3855.620000" }],
                format: { duration: "3855.620000" },
            }),
        );

        await expect(
            readAudioDurationMs(Buffer.from("OggS"), "audio/ogg"),
        ).resolves.toBe(3_855_620);
        expect(spawnMock).toHaveBeenCalledWith(
            "ffprobe",
            expect.arrayContaining(["-select_streams", "a:0"]),
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
    });

    it("rejects FFprobe results without an audio stream", async () => {
        parseBufferMock.mockResolvedValue({ format: {} });
        spawnMock.mockImplementation(() =>
            ffprobeProcess({ format: { duration: "12.000000" } }),
        );
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        await expect(
            readAudioDurationMs(Buffer.from("video"), "audio/ogg"),
        ).resolves.toBe(0);
        expect(consoleError).toHaveBeenCalledOnce();
        consoleError.mockRestore();
    });
});
