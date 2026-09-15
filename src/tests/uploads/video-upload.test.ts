import { describe, expect, it } from "vitest";
import { InvalidJobPayloadError } from "@/lib/jobs/types";
import {
    isSupportedUpload,
    shouldExtractVideo,
} from "@/lib/uploads/media-types";
import { parseVideoExtractionJobPayload } from "@/lib/uploads/video-extraction-payload";

describe("video upload classification", () => {
    it("accepts any browser-recognized video and sends it to FFmpeg", () => {
        expect(isSupportedUpload("camera.mts", "video/mp2t")).toBe(true);
        expect(shouldExtractVideo("camera.mts", "video/mp2t")).toBe(true);
    });

    it("uses common video extensions when MIME metadata is missing", () => {
        expect(isSupportedUpload("meeting.mkv", "")).toBe(true);
        expect(shouldExtractVideo("meeting.mkv", "")).toBe(true);
    });

    it("preserves direct uploads for audio-only ambiguous containers", () => {
        expect(shouldExtractVideo("voice.webm", "audio/webm")).toBe(false);
        expect(shouldExtractVideo("voice.mp4", "audio/mp4")).toBe(false);
    });

    it("extracts video variants of ambiguous containers", () => {
        expect(shouldExtractVideo("meeting.webm", "video/webm")).toBe(true);
        expect(shouldExtractVideo("meeting.mp4", "video/mp4")).toBe(true);
    });

    it("rejects unrelated files", () => {
        expect(isSupportedUpload("notes.txt", "text/plain")).toBe(false);
    });
});

describe("video extraction job payload", () => {
    it("parses a valid payload", () => {
        expect(
            parseVideoExtractionJobPayload({
                uploadId: "upload-1",
                sourceStorageKey: "user-1/video-uploads/upload-1",
                encryptedFilename: "encrypted",
                sourceSize: 123,
            }),
        ).toEqual({
            uploadId: "upload-1",
            sourceStorageKey: "user-1/video-uploads/upload-1",
            encryptedFilename: "encrypted",
            sourceSize: 123,
        });
    });

    it("rejects malformed payloads", () => {
        expect(() =>
            parseVideoExtractionJobPayload({
                uploadId: "upload-1",
                sourceStorageKey: "user-1/video-uploads/upload-1",
                encryptedFilename: "encrypted",
                sourceSize: -1,
            }),
        ).toThrow(InvalidJobPayloadError);
    });
});
