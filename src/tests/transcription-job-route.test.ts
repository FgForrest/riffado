import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    enqueueTranscriptionJob: vi.fn(),
    getActiveJob: vi.fn(),
    limit: vi.fn(),
    select: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: { select: mocks.select },
}));
vi.mock("@/db/queries/async-jobs", () => ({
    getActiveJob: mocks.getActiveJob,
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({
        user: { id: "user-1" },
    }),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/transcription/transcription-job", () => ({
    enqueueTranscriptionJob: mocks.enqueueTranscriptionJob,
    TRANSCRIPTION_JOB_KIND: "transcription",
}));

import { GET, POST } from "@/app/api/recordings/[id]/transcribe/route";
import { ErrorCode } from "@/lib/errors";

const context = { params: Promise.resolve({ id: "recording-1" }) };

function request(method = "GET", body?: Record<string, unknown>) {
    return new Request(
        "http://localhost/api/recordings/recording-1/transcribe",
        {
            method,
            ...(body
                ? {
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(body),
                  }
                : {}),
        },
    );
}

describe("recording transcription jobs route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.select.mockReturnValue({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({ limit: mocks.limit }),
            }),
        });
        mocks.limit.mockResolvedValue([{ id: "recording-1" }]);
        mocks.enqueueTranscriptionJob.mockResolvedValue({
            job: { id: "job-1", status: "pending" },
            created: true,
        });
    });

    it("queues a force-enabled manual job and returns immediately", async () => {
        const response = await POST(
            request("POST", {
                providerId: "provider-1",
                model: "whisper-large-v3",
            }),
            context,
        );

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({
            jobId: "job-1",
            status: "pending",
            created: true,
        });
        expect(mocks.enqueueTranscriptionJob).toHaveBeenCalledWith({
            userId: "user-1",
            recordingId: "recording-1",
            providerId: "provider-1",
            model: "whisper-large-v3",
            force: true,
            trigger: "manual",
        });
    });

    it("returns the existing job when another trigger already owns the work", async () => {
        mocks.enqueueTranscriptionJob.mockResolvedValue({
            job: { id: "job-auto", status: "processing" },
            created: false,
        });

        const response = await POST(request("POST"), context);

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
            jobId: "job-auto",
            status: "processing",
            created: false,
        });
    });

    it("reports an active background job only to its recording owner", async () => {
        mocks.getActiveJob.mockResolvedValue({
            id: "job-sync",
            userId: "user-1",
            status: "processing",
        });

        const response = await GET(request(), context);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            activeJob: { jobId: "job-sync", status: "processing" },
        });
        expect(mocks.getActiveJob).toHaveBeenCalledWith(
            "transcription",
            "recording-1",
        );
    });

    it("rejects a recording the caller does not own before queueing", async () => {
        mocks.limit.mockResolvedValue([]);

        const response = await POST(request("POST"), context);

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.RECORDING_NOT_FOUND,
        });
        expect(mocks.enqueueTranscriptionJob).not.toHaveBeenCalled();
    });
});
