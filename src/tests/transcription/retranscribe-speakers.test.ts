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
    decrypt: vi.fn((value: string) => value),
    encrypt: vi.fn((plaintext: string) => plaintext),
}));

vi.mock("@/lib/env", () => ({
    env: {
        WHISPER_MAX_BYTES: 24 * 1024 * 1024,
        WHISPER_COMPRESS_BITRATE_KBPS: 12,
        WHISPER_REQUEST_TIMEOUT_MS: 60 * 60 * 1000,
    },
}));

vi.mock("@/lib/entitlements", () => ({
    isHostedLockedOut: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("audio-data")),
    }),
}));

vi.mock("openai", () => ({
    // biome-ignore lint/complexity/useArrowFunction: mock must be constructable
    OpenAI: vi.fn(function () {
        return {
            audio: {
                transcriptions: {
                    create: vi.fn().mockResolvedValue({
                        segments: [
                            {
                                speaker: "speaker_0",
                                start: 0,
                                end: 1,
                                text: "Fresh",
                            },
                            {
                                speaker: "speaker_1",
                                start: 1,
                                end: 2,
                                text: "run",
                            },
                        ],
                    }),
                },
            },
        };
    }),
}));

vi.mock("@/lib/hosted/transcription/mynah", () => ({
    isMynahConfigured: vi.fn().mockReturnValue(false),
    transcribeViaMynah: vi.fn(),
}));

vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));

vi.mock("@/lib/ai/generate-title", () => ({
    generateTitleFromTranscription: vi.fn().mockResolvedValue("A title"),
}));

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/summary/summary-job", () => ({
    enqueueSummaryJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/transcription/persist", () => ({
    upsertTranscription: vi.fn().mockResolvedValue({ committed: true }),
}));

import { db } from "@/db";
import { transcriptSpeakers } from "@/db/schema";
import { exportRecordingSidecarsIfEnabled } from "@/lib/export/document-sidecars";
import { upsertTranscription } from "@/lib/transcription/persist";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";

const userId = "user-1";
const recordingId = "rec-1";
const transcriptionId = "tx-1";

/** One lookup's rows; a recording is read joined to its item. */
function rows(result: unknown[]) {
    const where = vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
    });
    return {
        from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({ where }),
            where,
        }),
    };
}

/**
 * The four lookups `transcribeRecording` makes before it calls a provider:
 * the recording, the existing 'riffado' transcript, the user's credentials
 * and their settings.
 */
function stubLookups(existingTranscript: Record<string, unknown> | null) {
    (db.select as Mock)
        .mockReturnValueOnce(
            rows([
                {
                    id: recordingId,
                    userId,
                    title: "meeting.mp3",
                    storagePath: "meeting.mp3",
                    deletedAt: null,
                    audioReapedAt: null,
                },
            ]),
        )
        .mockReturnValueOnce(
            rows(existingTranscript ? [existingTranscript] : []),
        )
        .mockReturnValueOnce(
            rows([
                {
                    id: "creds-1",
                    provider: "openai",
                    apiKey: "key",
                    defaultModel: "gpt-4o-transcribe-diarize",
                    baseUrl: null,
                },
            ]),
        )
        .mockReturnValueOnce(
            rows([{ autoGenerateTitle: false, autoSummarize: false }]),
        );
}

/** Records every `db.delete(table)` along with the `where` it was given. */
function captureDeletes(): { table: unknown; where: unknown }[] {
    const captured: { table: unknown; where: unknown }[] = [];
    (db.delete as Mock).mockImplementation((table: unknown) => ({
        where: vi.fn(async (where: unknown) => {
            captured.push({ table, where });
        }),
    }));
    return captured;
}

/**
 * A forced re-run overwrites the transcript, and with it the text its
 * speakers were named on. Moving the names is the transcript write's job
 * (`upsertTranscription` remaps them in its own transaction), so the run
 * itself never deletes speaker rows: it used to drop them whenever the
 * speaker count changed, which lost names a relabelled run could keep.
 */
describe("forced re-transcribe and speaker attributions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // A test that returns early leaves queued `mockReturnValueOnce`
        // answers behind, and `clearAllMocks` does not drain that queue.
        (db.select as Mock).mockReset();
        (db.update as Mock).mockReturnValue({
            set: vi.fn().mockReturnValue({ where: vi.fn() }),
        });
    });

    it("leaves the speaker rows to the transcript write", async () => {
        stubLookups({ id: transcriptionId, text: "speaker_0: Previous run" });
        const deletes = captureDeletes();

        const result = await transcribeRecording(userId, recordingId, {
            force: true,
        });

        expect(result.success).toBe(true);
        expect(upsertTranscription).toHaveBeenCalledWith(
            expect.objectContaining({
                userId,
                recordingId,
                source: "riffado",
                turns: [
                    expect.objectContaining({ speaker: "speaker_0" }),
                    expect.objectContaining({ speaker: "speaker_1" }),
                ],
            }),
        );
        expect(deletes.some((call) => call.table === transcriptSpeakers)).toBe(
            false,
        );
        // The summary was made from the old text, so it goes, in the same
        // write as the text.
        expect(upsertTranscription).toHaveBeenCalledWith(
            expect.objectContaining({ dropSummaryOnReplace: "riffado" }),
        );
    });

    it("keeps everything when a run is not forced", async () => {
        stubLookups({ id: transcriptionId, text: "Previous run" });
        const deletes = captureDeletes();

        const result = await transcribeRecording(userId, recordingId);

        // The short-circuit returns the stored transcript untouched, so the
        // labels it was attributed against still describe it.
        expect(result.text).toBe("Previous run");
        expect(upsertTranscription).not.toHaveBeenCalled();
        expect(deletes).toHaveLength(0);
    });

    it("writes the transcript, and so its speakers, before the sidecar", async () => {
        stubLookups({ id: transcriptionId, text: "speaker_0: Previous run" });
        captureDeletes();
        const order: string[] = [];
        (upsertTranscription as Mock).mockImplementation(async () => {
            order.push("write");
            return { committed: true };
        });
        (exportRecordingSidecarsIfEnabled as Mock).mockImplementation(
            async () => {
                order.push("sidecar");
            },
        );

        await transcribeRecording(userId, recordingId, { force: true });

        expect(order).toEqual(["write", "sidecar"]);
    });
});
