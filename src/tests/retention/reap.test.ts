import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteTranscriptsForRecording = vi.fn();
const deleteSummaryForRecording = vi.fn();
const markKindsReaped = vi.fn();
const clearReapedMarkers = vi.fn();
const claimRemoteOriginalReap = vi.fn();
const releaseRemoteOriginalReapClaim = vi.fn();
const movePlaudRecordingToTrash = vi.fn();

vi.mock("@/db/queries/retention", () => ({
    deleteTranscriptsForRecording: (...args: unknown[]) =>
        deleteTranscriptsForRecording(...args),
    deleteSummaryForRecording: (...args: unknown[]) =>
        deleteSummaryForRecording(...args),
    markKindsReaped: (...args: unknown[]) => markKindsReaped(...args),
    clearReapedMarkers: (...args: unknown[]) => clearReapedMarkers(...args),
    claimRemoteOriginalReap: (...args: unknown[]) =>
        claimRemoteOriginalReap(...args),
    releaseRemoteOriginalReapClaim: (...args: unknown[]) =>
        releaseRemoteOriginalReapClaim(...args),
}));
vi.mock("@/lib/recordings/erase", () => ({
    movePlaudRecordingToTrash: (...args: unknown[]) =>
        movePlaudRecordingToTrash(...args),
}));

import type { ReapCandidate, RetentionPolicy } from "@/db/queries/retention";
import { reapRecording, unmarkReaped } from "@/lib/retention/reap";
import type { StorageProvider } from "@/lib/storage/types";

const NOW = new Date("2026-09-13T12:00:00.000Z");

function policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
    return {
        userId: "user-1",
        remoteOriginalDays: null,
        audioDays: null,
        transcriptDays: null,
        summaryDays: null,
        ...overrides,
    };
}

function candidate(overrides: Partial<ReapCandidate> = {}): ReapCandidate {
    return {
        id: "rec-1",
        storagePath: "user-1/Board meeting.mp3",
        startTime: new Date("2026-07-01T00:00:00.000Z"),
        deviceSn: "plaud-device-1",
        downloadedAt: new Date("2026-07-01T00:01:00.000Z"),
        isTrash: false,
        audioReapedAt: null,
        transcriptReapedAt: null,
        summaryReapedAt: null,
        ...overrides,
    };
}

function storage(present = true) {
    const exists = vi.fn().mockResolvedValue(present);
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    return {
        provider: { exists, deleteFile } as unknown as StorageProvider,
        exists,
        deleteFile,
    };
}

describe("reapRecording", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        deleteTranscriptsForRecording.mockResolvedValue(0);
        deleteSummaryForRecording.mockResolvedValue(0);
        markKindsReaped.mockResolvedValue(undefined);
        clearReapedMarkers.mockResolvedValue(undefined);
        claimRemoteOriginalReap.mockResolvedValue(true);
        releaseRemoteOriginalReapClaim.mockResolvedValue(undefined);
        movePlaudRecordingToTrash.mockResolvedValue(undefined);
    });

    it("removes the audio blob and stamps only that kind", async () => {
        const s = storage();

        const result = await reapRecording(
            s.provider,
            policy({ audioDays: 30 }),
            candidate(),
            NOW,
        );

        expect(s.deleteFile).toHaveBeenCalledWith("user-1/Board meeting.mp3");
        expect(result.reaped).toEqual(["audio"]);
        expect(markKindsReaped).toHaveBeenCalledWith(
            "rec-1",
            "user-1",
            ["audio"],
            NOW,
        );
        expect(deleteTranscriptsForRecording).not.toHaveBeenCalled();
        expect(deleteSummaryForRecording).not.toHaveBeenCalled();
    });

    it("leaves the markdown sidecars alone", async () => {
        const s = storage();

        await reapRecording(
            s.provider,
            policy({ audioDays: 30, transcriptDays: 30, summaryDays: 30 }),
            candidate(),
            NOW,
        );

        // Exactly one delete, and it is the audio. A sweep must never
        // reach into the user's folder for `.transcript.md` / `.summary.md`
        // -- those are exports the user asked to have written, not
        // Riffado's own copy of the data.
        expect(s.deleteFile).toHaveBeenCalledTimes(1);
        expect(s.deleteFile).toHaveBeenCalledWith("user-1/Board meeting.mp3");
    });

    it("treats an already-missing blob as reaped instead of failing", async () => {
        const s = storage(false);

        const result = await reapRecording(
            s.provider,
            policy({ audioDays: 30 }),
            candidate(),
            NOW,
        );

        expect(s.deleteFile).not.toHaveBeenCalled();
        expect(result.reaped).toEqual(["audio"]);
    });

    it("skips kinds that were already reaped on an earlier sweep", async () => {
        const s = storage();

        const result = await reapRecording(
            s.provider,
            policy({ audioDays: 30, summaryDays: 30 }),
            candidate({
                audioReapedAt: new Date("2026-08-01T00:00:00.000Z"),
                summaryReapedAt: new Date("2026-08-01T00:00:00.000Z"),
            }),
            NOW,
        );

        expect(s.exists).not.toHaveBeenCalled();
        expect(deleteSummaryForRecording).not.toHaveBeenCalled();
        expect(result.reaped).toEqual([]);
    });

    it("does not stamp a transcript marker when there was no transcript", async () => {
        deleteTranscriptsForRecording.mockResolvedValue(0);
        const s = storage();

        const result = await reapRecording(
            s.provider,
            policy({ transcriptDays: 30 }),
            candidate(),
            NOW,
        );

        // Stamping here would be a lie, and it would permanently suppress
        // auto-transcribe for a recording that simply never had a run.
        expect(result.reaped).toEqual([]);
        expect(result.skipped.transcript).toBe("no transcript to remove");
        expect(markKindsReaped).toHaveBeenCalledWith(
            "rec-1",
            "user-1",
            [],
            NOW,
        );
    });

    it("stamps transcript and summary when rows were actually removed", async () => {
        deleteTranscriptsForRecording.mockResolvedValue(2);
        deleteSummaryForRecording.mockResolvedValue(1);
        const s = storage();

        const result = await reapRecording(
            s.provider,
            policy({ transcriptDays: 30, summaryDays: 30 }),
            candidate(),
            NOW,
        );

        expect(result.reaped).toEqual(["transcript", "summary"]);
        expect(deleteTranscriptsForRecording).toHaveBeenCalledWith(
            "rec-1",
            "user-1",
        );
        expect(deleteSummaryForRecording).toHaveBeenCalledWith(
            "rec-1",
            "user-1",
        );
    });

    it("reaps every selected kind in one pass", async () => {
        deleteTranscriptsForRecording.mockResolvedValue(1);
        deleteSummaryForRecording.mockResolvedValue(1);
        const s = storage();

        const result = await reapRecording(
            s.provider,
            policy({ audioDays: 30, transcriptDays: 30, summaryDays: 30 }),
            candidate(),
            NOW,
        );

        expect(result.reaped).toEqual(["audio", "transcript", "summary"]);
        expect(markKindsReaped).toHaveBeenCalledWith(
            "rec-1",
            "user-1",
            ["audio", "transcript", "summary"],
            NOW,
        );
    });

    it("applies each kind's retention period independently", async () => {
        deleteSummaryForRecording.mockResolvedValue(1);
        const s = storage();

        const result = await reapRecording(
            s.provider,
            policy({ audioDays: 10, summaryDays: 30 }),
            candidate({
                startTime: new Date("2026-08-25T00:00:00.000Z"),
            }),
            NOW,
        );

        expect(result.reaped).toEqual(["audio"]);
        expect(deleteSummaryForRecording).not.toHaveBeenCalled();
    });

    it("does nothing at all when the policy selects nothing", async () => {
        const s = storage();

        const result = await reapRecording(
            s.provider,
            policy(),
            candidate(),
            NOW,
        );

        expect(result.reaped).toEqual([]);
        expect(s.exists).not.toHaveBeenCalled();
        expect(deleteTranscriptsForRecording).not.toHaveBeenCalled();
        expect(deleteSummaryForRecording).not.toHaveBeenCalled();
    });

    it("moves the remote original to Trash only after a local download", async () => {
        const s = storage();

        const result = await reapRecording(
            s.provider,
            policy({ remoteOriginalDays: 30 }),
            candidate(),
            NOW,
        );

        expect(s.exists).not.toHaveBeenCalled();
        expect(claimRemoteOriginalReap).toHaveBeenCalledWith(
            "rec-1",
            "user-1",
            NOW,
        );
        expect(movePlaudRecordingToTrash).toHaveBeenCalledWith(
            "user-1",
            "rec-1",
        );
        expect(releaseRemoteOriginalReapClaim).toHaveBeenCalledWith(
            "rec-1",
            "user-1",
            NOW,
        );
        expect(result.reaped).toEqual(["remoteOriginal"]);
    });

    it("keeps the remote original until a local download has completed", async () => {
        const s = storage();

        const result = await reapRecording(
            s.provider,
            policy({ remoteOriginalDays: 30 }),
            candidate({ downloadedAt: null }),
            NOW,
        );

        expect(claimRemoteOriginalReap).not.toHaveBeenCalled();
        expect(movePlaudRecordingToTrash).not.toHaveBeenCalled();
        expect(result.skipped.remoteOriginal).toBe(
            "audio has not been downloaded locally",
        );
    });

    it("allows remote cleanup after local audio was later reaped", async () => {
        const s = storage(false);

        const result = await reapRecording(
            s.provider,
            policy({ remoteOriginalDays: 30 }),
            candidate({
                audioReapedAt: new Date("2026-08-01T00:00:00.000Z"),
            }),
            NOW,
        );

        expect(s.exists).not.toHaveBeenCalled();
        expect(movePlaudRecordingToTrash).toHaveBeenCalledWith(
            "user-1",
            "rec-1",
        );
        expect(result.reaped).toEqual(["remoteOriginal"]);
    });

    it("continues with independent local retention after a remote failure", async () => {
        const remoteError = new Error("remote unavailable");
        movePlaudRecordingToTrash.mockRejectedValue(remoteError);
        deleteTranscriptsForRecording.mockResolvedValue(1);
        const s = storage();

        const result = await reapRecording(
            s.provider,
            policy({ remoteOriginalDays: 30, transcriptDays: 30 }),
            candidate(),
            NOW,
        );

        expect(result.failed.remoteOriginal).toBe(remoteError);
        expect(result.reaped).toEqual(["transcript"]);
        expect(deleteTranscriptsForRecording).toHaveBeenCalled();
    });
});

describe("unmarkReaped", () => {
    beforeEach(() => vi.clearAllMocks());

    it("clears the markers for data that came back", async () => {
        await unmarkReaped("user-1", "rec-1", ["transcript"]);
        expect(clearReapedMarkers).toHaveBeenCalledWith("rec-1", "user-1", [
            "transcript",
        ]);
    });
});
