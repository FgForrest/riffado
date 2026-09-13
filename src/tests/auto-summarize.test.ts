import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock("@/lib/encryption", () => ({
    decrypt: vi.fn().mockReturnValue("fake-api-key"),
    encrypt: vi.fn((plaintext: string) => `encrypted:${plaintext}`),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("audio-data")),
    }),
}));

vi.mock("openai", () => {
    // biome-ignore lint/complexity/useArrowFunction: mock must be constructable
    const MockOpenAI = vi.fn(function () {
        return {
            audio: {
                transcriptions: {
                    create: vi.fn().mockResolvedValue({
                        text: "Fresh transcript",
                        language: "en",
                    }),
                },
            },
        };
    });
    return { OpenAI: MockOpenAI };
});

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/entitlements", () => ({
    isHostedLockedOut: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/env", () => ({
    env: {
        WHISPER_MAX_BYTES: 24 * 1024 * 1024,
        WHISPER_COMPRESS_BITRATE_KBPS: 12,
        WHISPER_REQUEST_TIMEOUT_MS: 60 * 60 * 1000,
        AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 60,
    },
}));

vi.mock("@/lib/hosted/transcription/mynah", () => ({
    isMynahConfigured: vi.fn().mockReturnValue(false),
    transcribeViaMynah: vi.fn(),
}));

vi.mock("@/lib/ai/generate-title", () => ({
    generateTitleFromTranscription: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));

vi.mock("@/lib/summary/summary-job", () => ({
    enqueueSummaryJob: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
    consumeRateLimitBucket: vi.fn().mockResolvedValue({
        allowed: true,
        limit: 60,
        remaining: 59,
        resetAt: new Date(Date.now() + 3600_000),
    }),
}));

import { db } from "@/db";
import { aiEnhancements } from "@/db/schema";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import { enqueueSummaryJob } from "@/lib/summary/summary-job";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";
import { emitEvent } from "@/lib/webhooks/emit";

type UserSettingsRow = {
    autoGenerateTitle: boolean;
    syncTitleToPlaud: boolean;
    autoSummarize: boolean;
    autoSummarizePreset: string | null;
};

/**
 * Mount the standard select-chain mocks that `transcribeRecording` walks
 * through before reaching the auto-summarize branch:
 *   1. recording lookup
 *   2. existing 'riffado' transcription (present iff `existingText` is set)
 *   3. legacy default credentials (transcription provider)
 *   4. userSettings row
 */
function mountSelectChain(
    settings: UserSettingsRow,
    existingText: string | null = null,
) {
    (db.select as Mock)
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([
                        {
                            id: "rec-1",
                            userId: "user-1",
                            plaudFileId: "plaud-1",
                            filename: "Original Title",
                            storagePath: "test.mp3",
                            deletedAt: null,
                        },
                    ]),
                }),
            }),
        })
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi
                        .fn()
                        .mockResolvedValue(
                            existingText
                                ? [{ id: "trans-1", text: existingText }]
                                : [],
                        ),
                }),
            }),
        })
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([
                        {
                            id: "creds-1",
                            provider: "openai",
                            apiKey: "encrypted-key",
                            defaultModel: "whisper-1",
                            baseUrl: null,
                        },
                    ]),
                }),
            }),
        })
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([settings]),
                }),
            }),
        });
}

function mountInsertTransaction() {
    const txInsertValues = vi.fn().mockResolvedValue(undefined);
    const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });
    const recordingBumpWhere = vi.fn().mockResolvedValue(undefined);
    const recordingBumpSet = vi.fn().mockReturnValue({
        where: recordingBumpWhere,
    });
    const txUpdate = vi.fn().mockReturnValue({ set: recordingBumpSet });
    const tx = {
        select: vi
            .fn()
            .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                    where: vi.fn().mockReturnValue({
                        for: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([{ deletedAt: null }]),
                        }),
                    }),
                }),
            })
            .mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                    where: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue([]),
                    }),
                }),
            }),
        insert: txInsert,
        update: txUpdate,
    };
    (db.transaction as Mock).mockImplementation(
        async (callback: (t: typeof tx) => Promise<unknown> | unknown) =>
            callback(tx),
    );
    (db.update as Mock).mockReturnValue({
        set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
        }),
    });
    (db.delete as Mock).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
    });
    return { txInsert };
}

describe("Auto-summarize integration with transcribeRecording", () => {
    const mockUserId = "user-1";
    const mockRecordingId = "rec-1";

    beforeEach(() => {
        vi.clearAllMocks();
        (consumeRateLimitBucket as Mock).mockResolvedValue({
            allowed: true,
            limit: 60,
            remaining: 59,
            resetAt: new Date(Date.now() + 3600_000),
        });
    });

    it("queues nothing when autoSummarize is false", async () => {
        mountSelectChain({
            autoGenerateTitle: false,
            syncTitleToPlaud: false,
            autoSummarize: false,
            autoSummarizePreset: null,
        });
        mountInsertTransaction();

        const result = await transcribeRecording(mockUserId, mockRecordingId);

        expect(result.success).toBe(true);
        expect(enqueueSummaryJob).not.toHaveBeenCalled();
        expect(emitEvent).toHaveBeenCalledWith(
            "transcription.completed",
            mockUserId,
            mockRecordingId,
        );
        const summaryEvents = (emitEvent as Mock).mock.calls.filter((c) =>
            String(c[0]).startsWith("summary."),
        );
        expect(summaryEvents).toHaveLength(0);
    });

    it("queues an auto summary with no preset when autoSummarize is true and preset is null", async () => {
        mountSelectChain({
            autoGenerateTitle: false,
            syncTitleToPlaud: false,
            autoSummarize: true,
            autoSummarizePreset: null,
        });
        mountInsertTransaction();
        (enqueueSummaryJob as Mock).mockResolvedValue({
            job: { id: "job-1" },
            created: true,
        });

        const result = await transcribeRecording(mockUserId, mockRecordingId);

        expect(result.success).toBe(true);
        expect(enqueueSummaryJob).toHaveBeenCalledTimes(1);
        expect(enqueueSummaryJob).toHaveBeenCalledWith({
            userId: mockUserId,
            recordingId: mockRecordingId,
            presetId: undefined,
            trigger: "auto",
        });
        // `summary.completed` is the job handler's to emit now. Emitting it
        // here would mean announcing a summary that has not been written yet
        // -- the whole point of queueing is that this function returns before
        // the work happens.
        const summaryEvents = (emitEvent as Mock).mock.calls.filter((c) =>
            String(c[0]).startsWith("summary."),
        );
        expect(summaryEvents).toHaveLength(0);
    });

    it("passes autoSummarizePreset into the queued job when set", async () => {
        mountSelectChain({
            autoGenerateTitle: false,
            syncTitleToPlaud: false,
            autoSummarize: true,
            autoSummarizePreset: "meeting-notes",
        });
        mountInsertTransaction();
        (enqueueSummaryJob as Mock).mockResolvedValue({
            job: { id: "job-1" },
            created: true,
        });

        const result = await transcribeRecording(mockUserId, mockRecordingId);

        expect(result.success).toBe(true);
        expect(enqueueSummaryJob).toHaveBeenCalledWith({
            userId: mockUserId,
            recordingId: mockRecordingId,
            presetId: "meeting-notes",
            trigger: "auto",
        });
    });

    it("keeps transcript success and emits summary.failed when queueing throws", async () => {
        mountSelectChain({
            autoGenerateTitle: false,
            syncTitleToPlaud: false,
            autoSummarize: true,
            autoSummarizePreset: null,
        });
        mountInsertTransaction();
        // Only a failure to QUEUE surfaces here now -- a database that
        // refused the insert. The summary itself has not been attempted.
        (enqueueSummaryJob as Mock).mockRejectedValue(
            new Error("Provider down"),
        );

        const result = await transcribeRecording(mockUserId, mockRecordingId);

        expect(result.success).toBe(true);
        expect(emitEvent).toHaveBeenCalledWith(
            "transcription.completed",
            mockUserId,
            mockRecordingId,
        );
        expect(emitEvent).toHaveBeenCalledWith(
            "summary.failed",
            mockUserId,
            mockRecordingId,
            { error: "Provider down" },
        );
        const completedSummary = (emitEvent as Mock).mock.calls.find(
            (c) => c[0] === "summary.completed",
        );
        expect(completedSummary).toBeUndefined();
    });

    it("skips auto-summary and emits summary.failed when rate limit is exhausted", async () => {
        mountSelectChain({
            autoGenerateTitle: false,
            syncTitleToPlaud: false,
            autoSummarize: true,
            autoSummarizePreset: null,
        });
        mountInsertTransaction();
        (consumeRateLimitBucket as Mock).mockResolvedValue({
            allowed: false,
            limit: 60,
            remaining: 0,
            resetAt: new Date(Date.now() + 3600_000),
        });

        const result = await transcribeRecording(mockUserId, mockRecordingId);

        expect(result.success).toBe(true);
        expect(enqueueSummaryJob).not.toHaveBeenCalled();
        expect(emitEvent).toHaveBeenCalledWith(
            "transcription.completed",
            mockUserId,
            mockRecordingId,
        );
        const failedCall = (emitEvent as Mock).mock.calls.find(
            (c) => c[0] === "summary.failed",
        );
        expect(failedCall).toBeDefined();
        expect(String(failedCall?.[3]?.error)).toMatch(/rate limit/i);
    });

    it("deletes the existing summary row on a forced re-transcribe", async () => {
        mountSelectChain(
            {
                autoGenerateTitle: false,
                syncTitleToPlaud: false,
                autoSummarize: false,
                autoSummarizePreset: null,
            },
            "Old transcript text",
        );
        mountInsertTransaction();

        const result = await transcribeRecording(mockUserId, mockRecordingId, {
            force: true,
        });

        expect(result.success).toBe(true);
        expect(db.delete).toHaveBeenCalledWith(aiEnhancements);
    });
});
