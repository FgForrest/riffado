import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock("@/lib/encryption", () => ({
    decrypt: vi.fn().mockReturnValue("sk_elevenlabs"),
    encrypt: vi.fn((plaintext: string) => `encrypted:${plaintext}`),
}));

vi.mock("@/lib/encryption/fields", async () => {
    const actual = await vi.importActual<
        typeof import("@/lib/encryption/fields")
    >("@/lib/encryption/fields");
    return {
        ...actual,
        decryptText: vi.fn((value: string) => value),
        encryptText: vi.fn((value: string) => `enc:${value}`),
    };
});

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("fake-mp3-bytes")),
    }),
}));

const audioCreate = vi.fn();
const chatCreate = vi.fn();

vi.mock("openai", () => {
    const MockOpenAI = vi.fn(() => ({
        audio: { transcriptions: { create: audioCreate } },
        chat: { completions: { create: chatCreate } },
    }));
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
    },
}));

vi.mock("@/lib/hosted/transcription/mynah", () => ({
    isMynahConfigured: vi.fn().mockReturnValue(false),
    transcribeViaMynah: vi.fn(),
}));

vi.mock("@/lib/transcription/ffmpeg", () => ({
    transcodeToMp3: vi.fn(),
    ffmpegToOpus: vi.fn(),
    runFfmpeg: vi.fn(),
}));

vi.mock("@/lib/ai/generate-title", () => ({
    generateTitleFromTranscription: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));

import { db } from "@/db";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";

interface CredentialRow {
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
}

function mockDbForCredential(credential: CredentialRow): void {
    (db.select as Mock)
        // recording lookup
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([
                        {
                            id: "rec-el",
                            userId: "user-el",
                            plaudFileId: "plaud-1",
                            filename: "Board meeting",
                            storagePath: "rec-el.mp3",
                            deletedAt: null,
                        },
                    ]),
                }),
            }),
        })
        // existing transcription
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([]),
                }),
            }),
        })
        // default transcription credentials
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([
                        {
                            id: "creds-el",
                            apiKey: "encrypted-key",
                            ...credential,
                        },
                    ]),
                }),
            }),
        })
        // user settings
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([
                        {
                            autoGenerateTitle: false,
                            syncTitleToPlaud: false,
                            autoSummarize: false,
                            transcriptionQuality: "balanced",
                            defaultTranscriptionLanguage: "cs",
                        },
                    ]),
                }),
            }),
        });

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
        insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
        }),
        update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
            }),
        }),
    };
    (db.transaction as Mock).mockImplementation(
        async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );
}

function scribeResponse(): Response {
    return new Response(
        JSON.stringify({
            text: "transcript from scribe",
            language_code: "cs",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

describe("ElevenLabs credentials route to Scribe, not the OpenAI SDK", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        audioCreate.mockReset();
        chatCreate.mockReset();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(scribeResponse()));
    });

    it("calls /v1/speech-to-text with the configured model and language", async () => {
        mockDbForCredential({
            provider: "ElevenLabs",
            baseUrl: null,
            defaultModel: "scribe_v2",
        });

        const result = await transcribeRecording("user-el", "rec-el");

        expect(result.success).toBe(true);
        expect(result.text).toBe("transcript from scribe");
        expect(result.detectedLanguage).toBe("cs");
        expect(audioCreate).not.toHaveBeenCalled();
        expect(chatCreate).not.toHaveBeenCalled();

        const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
            string,
            RequestInit,
        ];
        expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
        expect(init.headers).toEqual({ "xi-api-key": "sk_elevenlabs" });
        const form = init.body as FormData;
        expect(form.get("model_id")).toBe("scribe_v2");
        expect(form.get("language_code")).toBe("cs");
    });

    it("falls back to the preset default model when the credential has none", async () => {
        mockDbForCredential({
            provider: "ElevenLabs",
            baseUrl: null,
            defaultModel: null,
        });

        await transcribeRecording("user-el", "rec-el");

        const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
            string,
            RequestInit,
        ];
        expect((init.body as FormData).get("model_id")).toBe("scribe_v2");
    });

    it("honours a residency base URL stored on the credential", async () => {
        mockDbForCredential({
            provider: "ElevenLabs",
            baseUrl: "https://api.eu.residency.elevenlabs.io",
            defaultModel: "scribe_v2+diarize",
        });

        await transcribeRecording("user-el", "rec-el");

        const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
            string,
            RequestInit,
        ];
        expect(url).toBe(
            "https://api.eu.residency.elevenlabs.io/v1/speech-to-text",
        );
        const form = init.body as FormData;
        expect(form.get("model_id")).toBe("scribe_v2");
        expect(form.get("diarize")).toBe("true");
    });
});
