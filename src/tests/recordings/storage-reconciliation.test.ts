import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    copyExistingRecordingFiles: vi.fn(),
    createUserStorageProvider: vi.fn(),
    deleteOldRecordingFiles: vi.fn(),
    limit: vi.fn(),
    returning: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: mocks.select,
        update: mocks.update,
    },
}));
vi.mock("@/lib/recordings/storage-files", () => ({
    copyExistingRecordingFiles: mocks.copyExistingRecordingFiles,
    deleteOldRecordingFiles: mocks.deleteOldRecordingFiles,
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: mocks.createUserStorageProvider,
}));

import {
    reconcileRecordingStorage,
    recordingStorageNeedsReconciliation,
} from "@/lib/recordings/reconcile-storage";

function selection(result: unknown[]) {
    return {
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(result),
            }),
        }),
    };
}

describe("recording storage reconciliation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createUserStorageProvider.mockResolvedValue({});
        mocks.copyExistingRecordingFiles.mockResolvedValue([
            "user-1/legacy.mp3",
            "user-1/legacy.transcript.md",
        ]);
        mocks.deleteOldRecordingFiles.mockResolvedValue(undefined);
        mocks.select.mockReturnValue(selection([]));
        mocks.returning.mockResolvedValue([
            { storagePath: "user-1/rec-1-Board_meeting.mp3" },
        ]);
        mocks.update.mockReturnValue({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    returning: mocks.returning,
                }),
            }),
        });
    });

    it("recognizes the exact title-based filename tracked by storage_path", () => {
        expect(
            recordingStorageNeedsReconciliation({
                id: "rec-1",
                userId: "user-1",
                title: "Board meeting",
                storagePath: "user-1/rec-1-Board_meeting.mp3",
            }),
        ).toBe(false);
        expect(
            recordingStorageNeedsReconciliation({
                id: "rec-1",
                userId: "user-1",
                title: "Board meeting",
                storagePath: "user-1/legacy.mp3",
            }),
        ).toBe(true);
    });

    it("moves present files before updating PostgreSQL and deleting old keys", async () => {
        const storage = {};
        mocks.createUserStorageProvider.mockResolvedValue(storage);

        await expect(
            reconcileRecordingStorage({
                id: "rec-1",
                userId: "user-1",
                title: "Board meeting",
                storagePath: "user-1/legacy.mp3",
            }),
        ).resolves.toEqual({
            changed: true,
            storagePath: "user-1/rec-1-Board_meeting.mp3",
        });

        expect(mocks.copyExistingRecordingFiles).toHaveBeenCalledWith(
            storage,
            "user-1/legacy.mp3",
            "user-1/rec-1-Board_meeting.mp3",
        );
        expect(mocks.returning).toHaveBeenCalledTimes(1);
        expect(mocks.deleteOldRecordingFiles).toHaveBeenCalledWith(
            storage,
            ["user-1/legacy.mp3", "user-1/legacy.transcript.md"],
            "rec-1",
        );
    });

    it("does not delete a legacy key still referenced by another recording", async () => {
        mocks.select.mockReturnValue(selection([{ id: "rec-2" }]));

        await reconcileRecordingStorage({
            id: "rec-1",
            userId: "user-1",
            title: "Board meeting",
            storagePath: "user-1/legacy.mp3",
        });

        expect(mocks.deleteOldRecordingFiles).not.toHaveBeenCalled();
    });

    it("updates an empty tracked path without probing unsafe root sidecars", async () => {
        await reconcileRecordingStorage({
            id: "rec-1",
            userId: "user-1",
            title: "Board meeting",
            storagePath: "",
        });

        expect(mocks.copyExistingRecordingFiles).not.toHaveBeenCalled();
        expect(mocks.returning).toHaveBeenCalledTimes(1);
    });
});
