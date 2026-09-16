import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    copyExistingRecordingFiles: vi.fn(),
    createUserStorageProvider: vi.fn(),
    deleteOldRecordingFiles: vi.fn(),
    exists: vi.fn(),
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
    sidecarKey: (path: string, kind: string) =>
        `${path.replace(/\.[^.]+$/, "")}.${kind}.md`,
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: mocks.createUserStorageProvider,
}));

import {
    reconcileRecordingStorage,
    recordingStorageNeedsReconciliation,
    storageFilenameMatchesTitle,
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

function state(
    overrides: Partial<{
        id: string;
        userId: string;
        title: string;
        storagePath: string;
        storageFilename: string | null;
    }> = {},
) {
    return {
        id: "rec-1",
        userId: "user-1",
        title: "Board meeting",
        storagePath: "user-1/legacy.mp3",
        storageFilename: null,
        ...overrides,
    };
}

describe("recording storage reconciliation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.exists.mockResolvedValue(false);
        mocks.createUserStorageProvider.mockResolvedValue({
            exists: mocks.exists,
        });
        mocks.copyExistingRecordingFiles.mockResolvedValue([
            "user-1/legacy.mp3",
            "user-1/legacy.transcript.md",
        ]);
        mocks.deleteOldRecordingFiles.mockResolvedValue(undefined);
        mocks.select.mockReturnValue(selection([]));
        mocks.update.mockImplementation(() => ({
            set: vi
                .fn()
                .mockImplementation((values: Record<string, unknown>) => ({
                    where: vi.fn().mockReturnValue({
                        returning: vi.fn().mockResolvedValue([
                            "storageFilename" in values
                                ? {
                                      storageFilename: values.storageFilename,
                                  }
                                : { storagePath: values.storagePath },
                        ]),
                    }),
                })),
        }));
    });

    it("recognizes a readable reserved filename and its collision suffix", () => {
        expect(
            recordingStorageNeedsReconciliation(
                state({
                    storagePath: "user-1/Board_meeting.mp3",
                    storageFilename: "Board_meeting.mp3",
                }),
            ),
        ).toBe(false);
        expect(
            storageFilenameMatchesTitle(
                "Board_meeting-1.mp3",
                "Board meeting",
                "mp3",
            ),
        ).toBe(true);
        expect(recordingStorageNeedsReconciliation(state())).toBe(true);
    });

    it("reserves a readable name, moves files, and updates storage_path", async () => {
        const storage = { exists: mocks.exists };
        mocks.createUserStorageProvider.mockResolvedValue(storage);

        await expect(reconcileRecordingStorage(state())).resolves.toEqual({
            changed: true,
            storagePath: "user-1/Board_meeting.mp3",
            storageFilename: "Board_meeting.mp3",
        });

        expect(mocks.copyExistingRecordingFiles).toHaveBeenCalledWith(
            storage,
            "user-1/legacy.mp3",
            "user-1/Board_meeting.mp3",
        );
        expect(mocks.deleteOldRecordingFiles).toHaveBeenCalledWith(
            storage,
            ["user-1/legacy.mp3", "user-1/legacy.transcript.md"],
            "rec-1",
        );
    });

    it("adds a numeric suffix when the readable name is owned", async () => {
        mocks.select
            .mockReturnValueOnce(selection([{ id: "rec-2" }]))
            .mockReturnValue(selection([]));

        await expect(reconcileRecordingStorage(state())).resolves.toMatchObject(
            {
                storagePath: "user-1/Board_meeting-1.mp3",
                storageFilename: "Board_meeting-1.mp3",
            },
        );
    });

    it("retries with a suffix after a concurrent stem reservation", async () => {
        const conflict = Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint: "recordings_user_id_storage_filename_stem_unique",
        });
        let reservationAttempts = 0;
        mocks.update.mockImplementation(() => ({
            set: vi
                .fn()
                .mockImplementation((values: Record<string, unknown>) => ({
                    where: vi.fn().mockReturnValue({
                        returning: vi.fn().mockImplementation(() => {
                            if (
                                "storageFilename" in values &&
                                reservationAttempts++ === 0
                            ) {
                                return Promise.reject(conflict);
                            }
                            return Promise.resolve([
                                "storageFilename" in values
                                    ? {
                                          storageFilename:
                                              values.storageFilename,
                                      }
                                    : { storagePath: values.storagePath },
                            ]);
                        }),
                    }),
                })),
        }));

        await expect(reconcileRecordingStorage(state())).resolves.toMatchObject(
            {
                storagePath: "user-1/Board_meeting-1.mp3",
                storageFilename: "Board_meeting-1.mp3",
            },
        );
    });

    it("does not delete a legacy key still referenced by another recording", async () => {
        mocks.select
            .mockReturnValueOnce(selection([]))
            .mockReturnValueOnce(selection([{ id: "rec-2" }]));

        await reconcileRecordingStorage(state());

        expect(mocks.deleteOldRecordingFiles).not.toHaveBeenCalled();
    });

    it("updates an empty tracked path without probing unsafe root sidecars", async () => {
        await reconcileRecordingStorage(state({ storagePath: "" }));

        expect(mocks.copyExistingRecordingFiles).not.toHaveBeenCalled();
        expect(mocks.update).toHaveBeenCalledTimes(2);
    });
});
