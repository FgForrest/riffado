import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    enqueueJob: vi.fn(),
    nudge: vi.fn(),
    owners: [] as { userId: string }[],
    selectDistinct: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        selectDistinct: mocks.selectDistinct,
    },
}));
vi.mock("@/db/queries/async-jobs", () => ({
    enqueueJob: mocks.enqueueJob,
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: mocks.nudge }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));

import { InvalidJobPayloadError } from "@/lib/jobs/types";
import {
    enqueueStorageReconciliationJob,
    parseStorageReconciliationJobPayload,
    STORAGE_RECONCILIATION_JOB_KIND,
    STORAGE_RECONCILIATION_SCAN_JOB_KIND,
    seedStorageReconciliationJobs,
} from "@/lib/recordings/storage-reconciliation-job";

describe("storage reconciliation jobs", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.owners = [];
        mocks.selectDistinct.mockReturnValue({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockImplementation(() => mocks.owners),
            }),
        });
        mocks.enqueueJob.mockResolvedValue({
            job: { id: "job-1" },
            created: true,
        });
    });

    it("validates the persisted recording id", () => {
        expect(
            parseStorageReconciliationJobPayload({ recordingId: "rec-1" }),
        ).toEqual({ recordingId: "rec-1" });
        expect(() => parseStorageReconciliationJobPayload({})).toThrow(
            InvalidJobPayloadError,
        );
    });

    it("deduplicates per recording and wakes the durable worker", async () => {
        await enqueueStorageReconciliationJob({
            userId: "user-1",
            recordingId: "rec-1",
        });

        expect(mocks.enqueueJob).toHaveBeenCalledWith({
            userId: "user-1",
            kind: STORAGE_RECONCILIATION_JOB_KIND,
            subjectId: "rec-1",
            maxAttempts: 3,
            payload: { recordingId: "rec-1" },
        });
        expect(mocks.nudge).toHaveBeenCalledTimes(1);
    });

    it("seeds one user-scoped scan per recording owner on boot", async () => {
        mocks.owners = [{ userId: "user-1" }, { userId: "user-2" }];
        mocks.enqueueJob
            .mockResolvedValueOnce({ job: { id: "scan-1" }, created: true })
            .mockResolvedValueOnce({ job: { id: "scan-2" }, created: false });

        await expect(seedStorageReconciliationJobs()).resolves.toBe(1);
        expect(mocks.enqueueJob).toHaveBeenNthCalledWith(1, {
            userId: "user-1",
            kind: STORAGE_RECONCILIATION_SCAN_JOB_KIND,
            subjectId: "user-1",
            maxAttempts: 3,
            payload: {},
        });
        expect(mocks.enqueueJob).toHaveBeenNthCalledWith(2, {
            userId: "user-2",
            kind: STORAGE_RECONCILIATION_SCAN_JOB_KIND,
            subjectId: "user-2",
            maxAttempts: 3,
            payload: {},
        });
    });
});
