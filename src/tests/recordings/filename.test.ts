import { describe, expect, it } from "vitest";
import {
    audioExtension,
    buildDownloadFilename,
    buildRecordingStorageFilename,
    buildRecordingStoragePath,
    contentDispositionAttachment,
    isAudioDownloadRequest,
    MAX_RECORDING_TITLE_LENGTH,
    normalizeRecordingTitle,
    recordingAudioDownloadPath,
    sanitizeDownloadBasename,
    sanitizeStorageBasename,
} from "@/lib/recordings/filename";

describe("normalizeRecordingTitle", () => {
    it("trims and strips control characters", () => {
        expect(normalizeRecordingTitle("  Q4 planning\u0000  ")).toBe(
            "Q4 planning",
        );
        expect(normalizeRecordingTitle("\n\t")).toBe("");
    });
});

describe("audioExtension", () => {
    it("reads the trailing extension, defaulting to mp3", () => {
        expect(audioExtension("user-1/rec.wav")).toBe("wav");
        expect(audioExtension("user-1/rec.M4A")).toBe("m4a");
        expect(audioExtension("user-1/rec")).toBe("mp3");
    });
});

describe("sanitizeDownloadBasename", () => {
    it("replaces filesystem-illegal characters", () => {
        expect(sanitizeDownloadBasename('foo/bar:baz*"<>|')).toBe(
            "foo-bar-baz-----",
        );
    });

    it("collapses illegal characters and returns empty for whitespace", () => {
        expect(sanitizeDownloadBasename("///")).toBe("---");
        expect(sanitizeDownloadBasename("   ")).toBe("");
    });

    it("truncates to the shared title cap", () => {
        const long = "a".repeat(MAX_RECORDING_TITLE_LENGTH + 40);
        expect(sanitizeDownloadBasename(long).length).toBe(
            MAX_RECORDING_TITLE_LENGTH,
        );
    });

    it("prefixes Windows reserved device names, including with an extension", () => {
        expect(sanitizeDownloadBasename("CON")).toBe("_CON");
        expect(sanitizeDownloadBasename("lpt1")).toBe("_lpt1");
        expect(sanitizeDownloadBasename("COM3.mp3")).toBe("_COM3.mp3");
        expect(sanitizeDownloadBasename("nul")).toBe("_nul");
        expect(sanitizeDownloadBasename("AUX")).toBe("_AUX");
        expect(sanitizeDownloadBasename("PRN")).toBe("_PRN");
        expect(sanitizeDownloadBasename("Meeting")).toBe("Meeting");
    });
});

describe("buildDownloadFilename", () => {
    it("uses the safe title without an opaque recording id", () => {
        expect(buildDownloadFilename("Planning Call", "u/rec.mp3")).toBe(
            "Planning_Call.mp3",
        );
        expect(buildDownloadFilename("   ", "u/rec.wav")).toBe("untitled.wav");
    });

    it("does not double the extension when the title already has it", () => {
        expect(buildDownloadFilename("memo.m4a", "u/file.m4a")).toBe(
            "memo.m4a",
        );
        expect(buildDownloadFilename("memo.MP3", "u/file.mp3")).toBe(
            "memo.mp3",
        );
    });

    it("keeps unicode in the download name", () => {
        expect(buildDownloadFilename("会議 日本語", "u/a.mp3")).toBe(
            "会議_日本語.mp3",
        );
    });

    it("makes Windows reserved basenames safe", () => {
        expect(buildDownloadFilename("CON", "u/rec.mp3")).toBe("_CON.mp3");
        expect(buildDownloadFilename("CON.mp3", "u/rec.mp3")).toBe("_CON.mp3");
        expect(buildDownloadFilename("LPT1.wav", "u/rec.wav")).toBe(
            "_LPT1.wav",
        );
    });
});

describe("recording storage filenames", () => {
    it("converts titles into stable portable names", () => {
        expect(sanitizeStorageBasename("Můj titulek nahrávky")).toBe(
            "Muj_titulek_nahravky",
        );
        expect(
            buildRecordingStorageFilename("Můj titulek nahrávky", ".MP3"),
        ).toBe("Muj_titulek_nahravky.mp3");
        expect(
            buildRecordingStoragePath("user-1", "Můj titulek nahrávky", "mp3"),
        ).toBe("user-1/Muj_titulek_nahravky.mp3");
    });

    it("adds a numeric suffix only for collisions", () => {
        expect(buildRecordingStorageFilename("Weekly status", "mp3", 1)).toBe(
            "Weekly_status-1.mp3",
        );
    });

    it("bounds long unicode names by UTF-8 bytes", () => {
        const filename = buildRecordingStorageFilename("会".repeat(200), "mp3");
        expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(
            240,
        );
    });
});

describe("contentDispositionAttachment", () => {
    it("emits ASCII filename plus RFC 5987 filename*", () => {
        const header = contentDispositionAttachment("会議.mp3");
        expect(header).toContain('filename="__.mp3"');
        expect(header).toContain("filename*=UTF-8''");
        expect(header).toContain(encodeURIComponent("会議.mp3"));
    });

    it("escapes quotes in the ASCII fallback", () => {
        const header = contentDispositionAttachment('say "hi".mp3');
        expect(header).toContain('filename="say _hi_.mp3"');
    });
});

describe("isAudioDownloadRequest / recordingAudioDownloadPath", () => {
    it("treats download=1/true/yes as a download", () => {
        expect(
            isAudioDownloadRequest(
                new Request(
                    "http://localhost/api/recordings/x/audio?download=1",
                ),
            ),
        ).toBe(true);
        expect(
            isAudioDownloadRequest(
                new Request(
                    "http://localhost/api/recordings/x/audio?download=true",
                ),
            ),
        ).toBe(true);
        expect(
            isAudioDownloadRequest(
                new Request("http://localhost/api/recordings/x/audio"),
            ),
        ).toBe(false);
        expect(
            isAudioDownloadRequest(
                new Request(
                    "http://localhost/api/recordings/x/audio?download=0",
                ),
            ),
        ).toBe(false);
    });

    it("builds the session-cookie download path", () => {
        expect(recordingAudioDownloadPath("rec-1")).toBe(
            "/api/recordings/rec-1/audio?download=1",
        );
    });
});
