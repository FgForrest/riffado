import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        update: vi.fn(),
    },
}));

// Ownership lives in the access layer, tested against a real database in
// `src/tests/sharing/`; here the caller is the owner and the route's own
// lookup decides whether the recording exists.
vi.mock("@/lib/sharing/access", () => ({
    requireRecordingAccess: vi.fn(async (userId: string) => ({
        ownerUserId: userId,
        role: "owner",
    })),
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({
        user: { id: "user-1" },
    }),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(),
}));

vi.mock("@/lib/audio/server-waveform", () => ({
    generateServerWaveform: vi.fn(),
}));

import { PUT as generateWaveform } from "@/app/api/recordings/[id]/peaks/route";
import { db } from "@/db";
import { generateServerWaveform } from "@/lib/audio/server-waveform";
import { ErrorCode } from "@/lib/errors";
import { createUserStorageProvider } from "@/lib/storage/factory";

const audio = Buffer.from("ogg-audio");
const peaks = Array.from({ length: 500 }, (_, index) => index / 500);
const storage = { downloadFile: vi.fn() };

function selectRecording(row: unknown) {
    (db.select as Mock).mockReturnValue({
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(row ? [row] : []),
            }),
        }),
    });
}

function routeParams(id = "rec-1") {
    return { params: Promise.resolve({ id }) };
}

function request() {
    return new Request("http://localhost/api/recordings/rec-1/peaks", {
        method: "PUT",
    });
}

describe("PUT /api/recordings/[id]/peaks", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storage.downloadFile.mockResolvedValue(audio);
        (createUserStorageProvider as Mock).mockResolvedValue(storage);
        (generateServerWaveform as Mock).mockResolvedValue(peaks);
        (db.update as Mock).mockReturnValue({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
            }),
        });
    });

    it("decodes and stores waveform peaks for the authenticated recording", async () => {
        selectRecording({
            id: "rec-1",
            storagePath: "user-1/meeting.ogg",
            waveformPeaks: null,
            audioReapedAt: null,
        });

        const response = await generateWaveform(request(), routeParams());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ peaks });
        expect(storage.downloadFile).toHaveBeenCalledWith("user-1/meeting.ogg");
        expect(generateServerWaveform).toHaveBeenCalledWith(audio, 500);
        expect(db.update).toHaveBeenCalledTimes(1);
    });

    it("returns cached peaks without downloading audio", async () => {
        selectRecording({
            id: "rec-1",
            storagePath: "user-1/meeting.ogg",
            waveformPeaks: peaks,
            audioReapedAt: null,
        });

        const response = await generateWaveform(request(), routeParams());

        await expect(response.json()).resolves.toEqual({ peaks });
        expect(createUserStorageProvider).not.toHaveBeenCalled();
        expect(generateServerWaveform).not.toHaveBeenCalled();
    });

    it("does not expose a recording outside the authenticated user scope", async () => {
        selectRecording(null);

        const response = await generateWaveform(request(), routeParams());

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.RECORDING_NOT_FOUND,
        });
        expect(createUserStorageProvider).not.toHaveBeenCalled();
    });

    it("reports audio removed by retention as gone", async () => {
        selectRecording({
            id: "rec-1",
            storagePath: "user-1/meeting.ogg",
            waveformPeaks: null,
            audioReapedAt: new Date(),
        });

        const response = await generateWaveform(request(), routeParams());

        expect(response.status).toBe(410);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.RECORDING_DATA_REAPED,
        });
        expect(createUserStorageProvider).not.toHaveBeenCalled();
    });
});
