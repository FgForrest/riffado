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
                        text: "Fresh run",
                        language: "cs",
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
}));

vi.mock("@/lib/transcription/persist", () => ({
    upsertTranscription: vi.fn().mockResolvedValue({ committed: true }),
}));

import { db } from "@/db";
import { aiEnhancements, transcriptSpeakers } from "@/db/schema";
import { exportRecordingSidecarsIfEnabled } from "@/lib/export/document-sidecars";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";
import { exprReferencesColumn } from "../fixtures/drizzle-expr";

const userId = "user-1";
const recordingId = "rec-1";
const transcriptionId = "tx-1";

function rows(result: unknown[]) {
    return {
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(result),
            }),
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
                    filename: "meeting.mp3",
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
                    defaultModel: "whisper-1",
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

    it("drops the attributions of the transcript it overwrites", async () => {
        stubLookups({ id: transcriptionId, text: "Previous run" });
        const deletes = captureDeletes();

        const result = await transcribeRecording(userId, recordingId, {
            force: true,
        });

        expect(result.success).toBe(true);
        const speakerDelete = deletes.find(
            (call) => call.table === transcriptSpeakers,
        );
        expect(speakerDelete).toBeDefined();
        expect(
            exprReferencesColumn(
                speakerDelete?.where,
                transcriptSpeakers.userId,
            ),
        ).toBe(true);
        expect(
            exprReferencesColumn(
                speakerDelete?.where,
                transcriptSpeakers.transcriptionId,
            ),
        ).toBe(true);
        expect(deletes.some((call) => call.table === aiEnhancements)).toBe(
            true,
        );
    });

    it("keeps the attributions when a run is not forced", async () => {
        stubLookups({ id: transcriptionId, text: "Previous run" });
        const deletes = captureDeletes();

        const result = await transcribeRecording(userId, recordingId);

        // The short-circuit returns the stored transcript untouched, so the
        // labels it was attributed against still describe it.
        expect(result.text).toBe("Previous run");
        expect(deletes).toHaveLength(0);
    });

    it("drops the attributions before writing the transcript sidecar", async () => {
        stubLookups({ id: transcriptionId, text: "Previous run" });
        const order: string[] = [];
        (db.delete as Mock).mockImplementation((table: unknown) => ({
            where: vi.fn(async () => {
                if (table === transcriptSpeakers) order.push("delete");
            }),
        }));
        (exportRecordingSidecarsIfEnabled as Mock).mockImplementation(
            async () => {
                order.push("sidecar");
            },
        );

        await transcribeRecording(userId, recordingId, { force: true });

        expect(order).toEqual(["delete", "sidecar"]);
    });
});
