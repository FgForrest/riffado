import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { StorageProvider } from "@/lib/storage/types";

vi.mock("nanoid", () => ({ nanoid: () => "recording-1" }));
vi.mock("@/db", () => ({
    db: { insert: vi.fn() },
}));
vi.mock("@/lib/audio/ingest-waveform", () => ({
    generateIngestWaveform: vi.fn(),
}));
vi.mock("@/lib/encryption/fields", () => ({
    encryptText: vi.fn((value: string) => `encrypted:${value}`),
}));
vi.mock("@/lib/env", () => ({
    env: { DEFAULT_STORAGE_TYPE: "local" },
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/recordings/filename", () => ({
    buildRecordingStagingPath: vi.fn(() => "user-1/recording-1/audio.mp3"),
}));
vi.mock("@/lib/recordings/storage-reconciliation-job", () => ({
    enqueueStorageReconciliationJob: vi.fn().mockResolvedValue({
        created: true,
    }),
}));
vi.mock("@/lib/transcription/auto-transcribe-new-recording", () => ({
    autoTranscribeNewRecording: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/uploads/audio-duration", () => ({
    readAudioDurationMs: vi.fn().mockResolvedValue(60_000),
}));

import { db } from "@/db";
import { generateIngestWaveform } from "@/lib/audio/ingest-waveform";
import { saveUploadedAudio } from "@/lib/uploads/save-uploaded-audio";

describe("saveUploadedAudio", () => {
    const waveformPeaks = Array.from(
        { length: 500 },
        (_, index) => index / 500,
    );
    const values = vi.fn();
    const uploadFile = vi.fn().mockResolvedValue("stored");
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const storage = {
        uploadFile,
        deleteFile,
    } as unknown as StorageProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        uploadFile.mockResolvedValue("stored");
        deleteFile.mockResolvedValue(undefined);
        (generateIngestWaveform as Mock).mockResolvedValue(waveformPeaks);
        values.mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "recording-1" }]),
        });
        (db.insert as Mock).mockReturnValue({ values });
    });

    it("stores waveform peaks generated from the incoming audio", async () => {
        const buffer = Buffer.from("audio");

        await saveUploadedAudio({
            userId: "user-1",
            fileId: "uploaded-1",
            basename: "Interview",
            extension: ".mp3",
            buffer,
            storage,
            sourceExtension: ".mp3",
            convertedFromVideo: false,
        });

        expect(generateIngestWaveform).toHaveBeenCalledWith(buffer);
        expect(uploadFile).toHaveBeenCalledWith(
            "user-1/recording-1/audio.mp3",
            buffer,
            "audio/mpeg",
        );
        expect(values).toHaveBeenCalledWith(
            expect.objectContaining({ waveformPeaks }),
        );
    });
});
