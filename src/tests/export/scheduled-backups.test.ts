import { beforeEach, describe, expect, it, vi } from "vitest";

const { queriesMock, storageMock, envMock } = vi.hoisted(() => ({
    queriesMock: {
        claimPendingExportJobs: vi.fn(),
        selectExpiredExportJobs: vi.fn(),
        deleteExportJobRow: vi.fn(),
        completeExportJob: vi.fn(),
        recordExportJobFailure: vi.fn(),
        reclaimStaleProcessingExportJobs: vi.fn(),
        selectStaleStorageKeys: vi.fn(),
        clearStaleStorageKey: vi.fn(),
        listUsersDueForScheduledBackup: vi.fn(),
        createExportJob: vi.fn(),
        EXPORT_MAX_ATTEMPTS: 3,
    },
    storageMock: { deleteFile: vi.fn() },
    envMock: {
        APP_URL: "https://app.example.com",
        DEFAULT_STORAGE_TYPE: "local" as "local" | "s3",
        BACKUP_STORAGE_PATH: undefined as string | undefined,
        LOCAL_STORAGE_PATH: "./storage",
    },
}));

vi.mock("@/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/db/schema", () => ({ users: { id: "id", email: "email" } }));
vi.mock("@/db/queries/export-jobs", () => queriesMock);
vi.mock("@/lib/export/build-archive", () => ({
    buildAndUploadExportArchive: vi.fn(),
}));
vi.mock("@/lib/notifications/email", () => ({
    sendExportReadyEmail: vi.fn(),
}));
vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/storage/factory", () => ({
    createStorageProvider: () => storageMock,
    createBackupStorageProvider: () => storageMock,
}));

import { scheduleDueBackups } from "@/lib/export/worker";

describe("scheduleDueBackups", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        queriesMock.createExportJob.mockResolvedValue({ id: "job-x" });
    });

    it("queues one archive per due user", async () => {
        queriesMock.listUsersDueForScheduledBackup.mockResolvedValue([
            { userId: "user-1", frequency: "daily" },
            { userId: "user-2", frequency: "weekly" },
        ]);

        const queued = await scheduleDueBackups();

        expect(queued).toBe(2);
        expect(queriesMock.createExportJob).toHaveBeenCalledWith("user-1");
        expect(queriesMock.createExportJob).toHaveBeenCalledWith("user-2");
    });

    it("does nothing when nobody is due", async () => {
        queriesMock.listUsersDueForScheduledBackup.mockResolvedValue([]);

        expect(await scheduleDueBackups()).toBe(0);
        expect(queriesMock.createExportJob).not.toHaveBeenCalled();
    });

    it("keeps going when one user cannot be queued", async () => {
        queriesMock.listUsersDueForScheduledBackup.mockResolvedValue([
            { userId: "user-1", frequency: "daily" },
            { userId: "user-2", frequency: "daily" },
            { userId: "user-3", frequency: "daily" },
        ]);
        queriesMock.createExportJob
            .mockResolvedValueOnce({ id: "job-1" })
            .mockRejectedValueOnce(new Error("deadlock"))
            .mockResolvedValueOnce({ id: "job-3" });

        // One user's failure must not cost everyone behind them in the
        // list their scheduled backup for the whole window.
        expect(await scheduleDueBackups()).toBe(2);
        expect(queriesMock.createExportJob).toHaveBeenCalledTimes(3);
    });
});
