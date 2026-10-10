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
    const MockOpenAI = vi.fn(() => ({
        audio: {
            transcriptions: {
                create: vi.fn(),
            },
        },
    }));
    return { OpenAI: MockOpenAI };
});

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/entitlements", () => ({
    isHostedLockedOut: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/ai/usage-cost", () => ({
    recordAiUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/env", () => ({
    env: {
        WHISPER_MAX_BYTES: 24 * 1024 * 1024,
        WHISPER_COMPRESS_BITRATE_KBPS: 12,
        WHISPER_REQUEST_TIMEOUT_MS: 60 * 60 * 1000,
    },
}));

vi.mock("@/lib/hosted/transcription/mynah", () => ({
    isMynahConfigured: vi.fn().mockReturnValue(false),
    transcribeViaMynah: vi.fn(),
}));

vi.mock("@/lib/ai/generate-title", () => ({
    generateTitleFromTranscription: vi
        .fn()
        .mockResolvedValue("Generated Title"),
}));

vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));

// Storing the title runs as written (the database mock answers it); the
// re-read before the Plaud push is steered per test.
const { titleStillGenerated } = vi.hoisted(() => ({
    titleStillGenerated: vi.fn(),
}));
vi.mock("@/lib/recordings/generated-title", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("@/lib/recordings/generated-title")
    >()),
    titleStillGenerated,
}));

vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));

// Carrying speaker rows and corrections over is tested against a real
// database (`attribution-remap`, `corrections` integration tests); here
// only that it happens.
vi.mock("@/lib/knowledge/attribution", () => ({
    copyMatchingSpeakerAttributions: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/knowledge/transcript-rewrite", () => ({
    transcriptRewrittenInTx: vi.fn(),
    stampNewTranscriptAudioInTx: vi.fn(),
}));
vi.mock("@/lib/knowledge/speaker-labels", () => ({
    storedSpeakerVersion: () => ({ turns: null, labels: ["speaker_0"] }),
}));

import { OpenAI } from "openai";
import { db } from "@/db";
import { chatterItems, recordings } from "@/db/schema";
import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import { refreshExistingRecordingSidecars } from "@/lib/export/document-sidecars";
import { transcriptRewrittenInTx } from "@/lib/knowledge/transcript-rewrite";
import { createPlaudClient } from "@/lib/plaud/client-factory";
import {
    storeBrowserTranscription,
    transcribeRecording,
} from "@/lib/transcription/transcribe-recording";
import { emitEvent } from "@/lib/webhooks/emit";
import { exprReferencesColumn } from "./fixtures/drizzle-expr";

/** The recording lookup: a recording joined to its item. */
function recordingLookup(rows: unknown[]) {
    const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: vi.fn().mockResolvedValue(rows),
    };
    return chain;
}

describe("Transcription", () => {
    const mockUserId = "user-123";
    const mockRecordingId = "rec-456";

    beforeEach(() => {
        vi.clearAllMocks();
        (db.delete as Mock).mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
        });
        // biome-ignore lint/complexity/useArrowFunction: mock must be constructable
        (OpenAI as unknown as Mock).mockImplementation(function () {
            return {
                audio: {
                    transcriptions: {
                        create: vi.fn(),
                    },
                },
            };
        });
    });

    describe("transcribeRecording", () => {
        it("should return error when recording not found", async () => {
            (db.select as Mock).mockReturnValue(recordingLookup([]));

            const result = await transcribeRecording(
                mockUserId,
                mockRecordingId,
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("Recording not found");
        });

        it("should return success when transcription already exists", async () => {
            (db.select as Mock)
                .mockReturnValueOnce(
                    recordingLookup([
                        { id: mockRecordingId, title: "test.mp3" },
                    ]),
                )
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi
                                .fn()
                                .mockResolvedValue([
                                    { id: "trans-1", text: "Existing text" },
                                ]),
                        }),
                    }),
                });

            const result = await transcribeRecording(
                mockUserId,
                mockRecordingId,
            );

            expect(result.success).toBe(true);
        });

        it("should return error when no API credentials configured", async () => {
            (db.select as Mock)
                .mockReturnValueOnce(
                    recordingLookup([
                        {
                            id: mockRecordingId,
                            title: "test.mp3",
                            storagePath: "test.mp3",
                        },
                    ]),
                )
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([]),
                        }),
                    }),
                });

            const result = await transcribeRecording(
                mockUserId,
                mockRecordingId,
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("No transcription API configured");
        });

        it("fails fast (does not fall back to Mynah) when an explicit providerId override doesn't resolve", async () => {
            const { isMynahConfigured, transcribeViaMynah } = await import(
                "@/lib/hosted/transcription/mynah"
            );
            (isMynahConfigured as Mock).mockReturnValueOnce(true);

            (db.select as Mock)
                .mockReturnValueOnce(
                    recordingLookup([
                        {
                            id: mockRecordingId,
                            title: "test.mp3",
                            storagePath: "test.mp3",
                        },
                    ]),
                )
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([]),
                        }),
                    }),
                })
                // Explicit providerId lookup finds nothing (stale/invalid/other user's id).
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([]),
                        }),
                    }),
                });

            const result = await transcribeRecording(
                mockUserId,
                mockRecordingId,
                { providerId: "stale-provider-id" },
            );

            expect(result.success).toBe(false);
            expect(result.errorCode).toBe("NO_TRANSCRIPTION_PROVIDER");
            expect(transcribeViaMynah).not.toHaveBeenCalled();
        });

        it("should return error when API call fails", async () => {
            const mockCreate = vi
                .fn()
                .mockRejectedValue(new Error("API Error"));
            // biome-ignore lint/complexity/useArrowFunction: mock must be constructable
            (OpenAI as unknown as Mock).mockImplementation(function () {
                return {
                    audio: { transcriptions: { create: mockCreate } },
                };
            });

            (db.select as Mock)
                .mockReturnValueOnce(
                    recordingLookup([
                        {
                            id: mockRecordingId,
                            title: "test.mp3",
                            storagePath: "test.mp3",
                        },
                    ]),
                )
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([]),
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
                                .mockResolvedValue([{ id: "settings-1" }]),
                        }),
                    }),
                });

            const result = await transcribeRecording(
                mockUserId,
                mockRecordingId,
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe("API Error");
        });

        /**
         * A run that transcribes, then generates a title. `retitled` is
         * whether the title update matched a row, i.e. no person had set
         * the title.
         */
        function stubTitledRun({
            syncTitleToPlaud,
            retitled,
        }: {
            syncTitleToPlaud: boolean;
            retitled: boolean;
        }) {
            const mockCreate = vi.fn().mockResolvedValue({
                text: "Fresh transcript",
                language: "en",
            });
            // biome-ignore lint/complexity/useArrowFunction: mock must be constructable
            (OpenAI as unknown as Mock).mockImplementation(function () {
                return {
                    audio: { transcriptions: { create: mockCreate } },
                };
            });
            (generateTitleFromTranscription as Mock).mockResolvedValue(
                "Generated Title",
            );

            (db.select as Mock)
                .mockReturnValueOnce(
                    recordingLookup([
                        {
                            id: mockRecordingId,
                            userId: mockUserId,
                            plaudFileId: "plaud-1",
                            title: "Original Title",
                            storagePath: "test.mp3",
                            deletedAt: null,
                        },
                    ]),
                )
                .mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([]),
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
                            limit: vi.fn().mockResolvedValue([
                                {
                                    autoGenerateTitle: true,
                                    syncTitleToPlaud,
                                },
                            ]),
                        }),
                    }),
                });

            const txInsertValues = vi.fn().mockResolvedValue(undefined);
            const txInsert = vi.fn().mockReturnValue({
                values: txInsertValues,
            });
            const recordingBumpWhere = vi.fn().mockResolvedValue(undefined);
            const recordingBumpSet = vi.fn().mockReturnValue({
                where: recordingBumpWhere,
            });
            const txUpdate = vi.fn().mockReturnValue({
                set: recordingBumpSet,
            });
            // The transcript write locks the recording joined to its item.
            const recordingLock = {
                from: () => recordingLock,
                innerJoin: () => recordingLock,
                where: () => recordingLock,
                for: () => recordingLock,
                limit: () => Promise.resolve([{ deletedAt: null }]),
            };
            const tx = {
                select: vi
                    .fn()
                    .mockReturnValueOnce(recordingLock)
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
            // The generated title is stored in a transaction of its own,
            // which locks the recording first.
            const titleLock = {
                from: () => titleLock,
                where: () => titleLock,
                for: () => Promise.resolve([{ id: mockRecordingId }]),
            };
            const titleTx = {
                select: () => titleLock,
                update: (...args: unknown[]) => (db.update as Mock)(...args),
            };
            (db.transaction as Mock)
                .mockImplementationOnce(
                    async (
                        callback: (
                            transaction: typeof tx,
                        ) => Promise<unknown> | unknown,
                    ) => callback(tx),
                )
                .mockImplementationOnce(
                    async (
                        callback: (
                            transaction: typeof titleTx,
                        ) => Promise<unknown> | unknown,
                    ) => callback(titleTx),
                );

            // The title is written only while no person has set one; the
            // update says whether it matched a row.
            const titleUpdateReturning = vi
                .fn()
                .mockResolvedValue(retitled ? [{ id: mockRecordingId }] : []);
            const titleUpdateWhere = vi
                .fn()
                .mockReturnValue({ returning: titleUpdateReturning });
            const titleUpdateSet = vi.fn().mockReturnValue({
                where: titleUpdateWhere,
            });
            (db.update as Mock).mockReturnValue({
                set: titleUpdateSet,
            });

            return {
                txInsert,
                txUpdate,
                recordingBumpSet,
                titleUpdateSet,
                titleUpdateWhere,
            };
        }

        it("bumps recording updatedAt and emits completion after generated title is stored", async () => {
            const {
                txInsert,
                txUpdate,
                recordingBumpSet,
                titleUpdateSet,
                titleUpdateWhere,
            } = stubTitledRun({ syncTitleToPlaud: false, retitled: true });

            const result = await transcribeRecording(
                mockUserId,
                mockRecordingId,
            );

            expect(result.success).toBe(true);
            expect(txInsert).toHaveBeenCalled();
            expect(txUpdate.mock.calls.map(([table]) => table)).toEqual([
                recordings,
                chatterItems,
            ]);
            expect(recordingBumpSet.mock.calls.map(([set]) => set)).toEqual([
                { updatedAt: expect.any(Date) },
                {
                    updatedAt: expect.any(Date),
                    // Persisting a transcript also clears any retention marker.
                    contentReapedAt: null,
                },
            ]);
            // The title is the item's; the recording's own updatedAt moves
            // with it.
            expect(
                (db.update as Mock).mock.calls.map(([table]) => table),
            ).toEqual([chatterItems, recordings]);
            expect(titleUpdateSet).toHaveBeenNthCalledWith(1, {
                title: "v1:encrypted:Generated Title",
                updatedAt: expect.any(Date),
            });
            expect(titleUpdateSet).toHaveBeenNthCalledWith(2, {
                updatedAt: expect.any(Date),
            });
            expect(emitEvent).toHaveBeenCalledWith(
                "transcription.completed",
                mockUserId,
                mockRecordingId,
            );
            expect(
                (emitEvent as Mock).mock.invocationCallOrder[0],
            ).toBeGreaterThan(titleUpdateWhere.mock.invocationCallOrder[0]);
            // The export directory follows the new title.
            expect(refreshExistingRecordingSidecars).toHaveBeenCalledWith(
                mockUserId,
                mockRecordingId,
            );
            expect(
                (refreshExistingRecordingSidecars as Mock).mock
                    .invocationCallOrder[0],
            ).toBeGreaterThan(titleUpdateWhere.mock.invocationCallOrder[0]);
        });

        it("keeps a title a person set, and pushes nothing to Plaud", async () => {
            const { titleUpdateWhere } = stubTitledRun({
                syncTitleToPlaud: true,
                retitled: false,
            });

            const result = await transcribeRecording(
                mockUserId,
                mockRecordingId,
            );

            expect(result.success).toBe(true);
            // The rename check is in the update itself, so a rename that
            // commits while the title is generated still wins.
            expect(
                exprReferencesColumn(
                    titleUpdateWhere.mock.calls[0]?.[0],
                    chatterItems.titleEditedAt,
                ),
            ).toBe(true);
            expect(refreshExistingRecordingSidecars).not.toHaveBeenCalled();
            expect(createPlaudClient).not.toHaveBeenCalled();
        });
        describe("pushing the generated title to Plaud", () => {
            function stubPlaud() {
                (db.select as Mock).mockReturnValueOnce({
                    from: vi.fn().mockReturnValue({
                        where: vi.fn().mockReturnValue({
                            limit: vi.fn().mockResolvedValue([
                                {
                                    id: "conn-1",
                                    bearerToken: "token",
                                    apiBase: null,
                                    workspaceId: "ws-1",
                                },
                            ]),
                        }),
                    }),
                });
                const updateFilename = vi.fn().mockResolvedValue(undefined);
                (createPlaudClient as Mock).mockResolvedValue({
                    updateFilename,
                    workspaceId: "ws-1",
                });
                return updateFilename;
            }

            it("pushes it while nobody renamed the recording", async () => {
                stubTitledRun({ syncTitleToPlaud: true, retitled: true });
                const updateFilename = stubPlaud();
                titleStillGenerated.mockResolvedValue(true);

                await transcribeRecording(mockUserId, mockRecordingId);

                expect(titleStillGenerated).toHaveBeenCalledWith(
                    mockUserId,
                    mockRecordingId,
                );
                expect(updateFilename).toHaveBeenCalledWith(
                    "plaud-1",
                    "Generated Title",
                );
            });

            it("keeps it from Plaud once a person renamed the recording", async () => {
                stubTitledRun({ syncTitleToPlaud: true, retitled: true });
                const updateFilename = stubPlaud();
                titleStillGenerated.mockResolvedValue(false);

                const result = await transcribeRecording(
                    mockUserId,
                    mockRecordingId,
                );

                expect(result.success).toBe(true);
                expect(updateFilename).not.toHaveBeenCalled();
            });
        });
    });

    describe("storeBrowserTranscription", () => {
        function mockOwnershipLookup(rows: unknown[]) {
            (db.select as Mock).mockReturnValueOnce({
                from: vi.fn().mockReturnValue({
                    where: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue(rows),
                    }),
                }),
            });
        }

        function makeTxMock(opts: {
            stillActive: { deletedAt: Date | null } | null;
            existingTranscription: { id: string } | null;
        }) {
            const txInsertValues = vi.fn().mockResolvedValue(undefined);
            const txInsert = vi
                .fn()
                .mockReturnValue({ values: txInsertValues });
            const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
            const txUpdateSet = vi
                .fn()
                .mockReturnValue({ where: txUpdateWhere });
            const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet });

            const tx = {
                select: vi
                    .fn()
                    .mockReturnValueOnce({
                        from: vi.fn().mockReturnValue({
                            where: vi.fn().mockReturnValue({
                                for: vi.fn().mockReturnValue({
                                    limit: vi
                                        .fn()
                                        .mockResolvedValue(
                                            opts.stillActive
                                                ? [opts.stillActive]
                                                : [],
                                        ),
                                }),
                            }),
                        }),
                    })
                    .mockReturnValueOnce({
                        from: vi.fn().mockReturnValue({
                            where: vi.fn().mockReturnValue({
                                limit: vi
                                    .fn()
                                    .mockResolvedValue(
                                        opts.existingTranscription
                                            ? [opts.existingTranscription]
                                            : [],
                                    ),
                            }),
                        }),
                    }),
                insert: txInsert,
                update: txUpdate,
                // The summary of the replaced text goes in the same write.
                delete: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue(undefined),
                }),
            };
            (db.transaction as Mock).mockImplementation(
                async (
                    callback: (
                        transaction: typeof tx,
                    ) => Promise<unknown> | unknown,
                ) => callback(tx),
            );
            return { tx, txInsert, txInsertValues, txUpdate, txUpdateSet };
        }

        it("returns HOSTED_LOCKED_OUT (not TRANSCRIPTION_FAILED) when the account is lapsed", async () => {
            const { isHostedLockedOut } = await import("@/lib/entitlements");
            (isHostedLockedOut as Mock).mockResolvedValueOnce(true);
            const result = await storeBrowserTranscription({
                userId: mockUserId,
                recordingId: mockRecordingId,
                text: "hello world",
                detectedLanguage: "en",
                model: "whisper-base",
            });
            expect(result.success).toBe(false);
            expect(result.errorCode).toBe("HOSTED_LOCKED_OUT");
            expect(emitEvent).not.toHaveBeenCalled();
        });

        it("returns RECORDING_NOT_FOUND when recording does not exist or is tombstoned", async () => {
            mockOwnershipLookup([]);
            const result = await storeBrowserTranscription({
                userId: mockUserId,
                recordingId: mockRecordingId,
                text: "hello world",
                detectedLanguage: "en",
                model: "whisper-base",
            });
            expect(result.success).toBe(false);
            expect(result.errorCode).toBe("RECORDING_NOT_FOUND");
            expect(emitEvent).not.toHaveBeenCalled();
        });

        it("returns RECORDING_DELETED when the row is tombstoned mid-transaction", async () => {
            mockOwnershipLookup([{ id: mockRecordingId, deletedAt: null }]);
            makeTxMock({
                stillActive: { deletedAt: new Date() },
                existingTranscription: null,
            });
            const result = await storeBrowserTranscription({
                userId: mockUserId,
                recordingId: mockRecordingId,
                text: "hello world",
                detectedLanguage: "en",
                model: "whisper-base",
            });
            expect(result.success).toBe(false);
            expect(result.errorCode).toBe("RECORDING_DELETED");
            expect(emitEvent).not.toHaveBeenCalled();
        });

        it("inserts a new transcription row with type='browser' and provider='browser' (model preserved)", async () => {
            mockOwnershipLookup([{ id: mockRecordingId, deletedAt: null }]);
            const harness = makeTxMock({
                stillActive: { deletedAt: null },
                existingTranscription: null,
            });

            const result = await storeBrowserTranscription({
                userId: mockUserId,
                recordingId: mockRecordingId,
                text: "new transcript text",
                detectedLanguage: "fr",
                model: "whisper-base",
            });

            expect(result.success).toBe(true);
            expect(result.text).toBe("new transcript text");
            expect(result.detectedLanguage).toBe("fr");
            expect(harness.txInsert).toHaveBeenCalled();
            const inserted = harness.txInsertValues.mock.calls[0][0] as Record<
                string,
                unknown
            >;
            expect(inserted.transcriptionType).toBe("browser");
            expect(inserted.provider).toBe("browser");
            expect(inserted.model).toBe("whisper-base");
            expect(inserted.detectedLanguage).toBe("fr");
            // Text is at-rest-encrypted before storage.
            expect(inserted.text).toBe("v1:encrypted:new transcript text");
            expect(emitEvent).toHaveBeenCalledWith(
                "transcription.completed",
                mockUserId,
                mockRecordingId,
            );
        });

        it("updates an existing transcription row (idempotent re-run)", async () => {
            mockOwnershipLookup([{ id: mockRecordingId, deletedAt: null }]);
            const harness = makeTxMock({
                stillActive: { deletedAt: null },
                existingTranscription: { id: "trans-existing" },
            });

            const result = await storeBrowserTranscription({
                userId: mockUserId,
                recordingId: mockRecordingId,
                text: "updated transcript",
                detectedLanguage: null,
                model: "whisper-small",
            });

            expect(result.success).toBe(true);
            expect(harness.txInsert).not.toHaveBeenCalled();
            expect(harness.txUpdate).toHaveBeenCalled();
            const updated = harness.txUpdateSet.mock.calls[0][0] as Record<
                string,
                unknown
            >;
            expect(updated.transcriptionType).toBe("browser");
            expect(updated.provider).toBe("browser");
            expect(updated.model).toBe("whisper-small");
            expect(updated.detectedLanguage).toBeNull();
            // A browser transcript has no speakers, so the old ones'
            // names have nowhere to go.
            expect(transcriptRewrittenInTx).toHaveBeenCalledWith(
                expect.anything(),
                {
                    userId: mockUserId,
                    transcriptionId: "trans-existing",
                    previous: { turns: null, labels: ["speaker_0"] },
                    next: { turns: null, labels: [] },
                    // Which audio the browser fetched is not known.
                    audioMd5: null,
                },
            );
            expect(emitEvent).toHaveBeenCalledWith(
                "transcription.completed",
                mockUserId,
                mockRecordingId,
            );
        });

        it("clears the turns of the run it replaces", async () => {
            mockOwnershipLookup([{ id: mockRecordingId, deletedAt: null }]);
            const harness = makeTxMock({
                stillActive: { deletedAt: null },
                existingTranscription: { id: "trans-existing" },
            });

            await storeBrowserTranscription({
                userId: mockUserId,
                recordingId: mockRecordingId,
                text: "flat undiarized prose",
                detectedLanguage: null,
                model: "whisper-base",
            });

            const updated = harness.txUpdateSet.mock.calls[0][0] as Record<
                string,
                unknown
            >;
            expect(updated.turns).toBeNull();
        });

        it("stores no turns on the row it creates", async () => {
            mockOwnershipLookup([{ id: mockRecordingId, deletedAt: null }]);
            const harness = makeTxMock({
                stillActive: { deletedAt: null },
                existingTranscription: null,
            });

            await storeBrowserTranscription({
                userId: mockUserId,
                recordingId: mockRecordingId,
                text: "flat undiarized prose",
                detectedLanguage: null,
                model: "whisper-base",
            });

            const inserted = harness.txInsertValues.mock.calls[0][0] as Record<
                string,
                unknown
            >;
            expect(inserted.turns).toBeNull();
        });
    });
});
