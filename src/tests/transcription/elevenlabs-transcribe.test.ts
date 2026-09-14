import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        WHISPER_REQUEST_TIMEOUT_MS: 60 * 60 * 1000,
    },
}));

import {
    ElevenLabsTranscribeError,
    elevenLabsTranscribe,
    parseElevenLabsModel,
    resolveElevenLabsUrl,
} from "@/lib/transcription/elevenlabs-transcribe";
import { expectTextAndTurnsAgree } from "./turns-parity";

/** One `words` entry in the shape the transcription endpoint returns. */
function spoken(
    text: string,
    speakerId: string,
    start: number,
    end: number,
): {
    text: string;
    type: string;
    speaker_id: string;
    start: number;
    end: number;
} {
    return { text, type: "word", speaker_id: speakerId, start, end };
}

function audioFile(): File {
    return new File([new Uint8Array([1, 2, 3])], "meeting.mp3", {
        type: "audio/mpeg",
    });
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function lastRequest(): { url: string; init: RequestInit; form: FormData } {
    const call = vi.mocked(globalThis.fetch).mock.calls.at(-1);
    if (!call) {
        throw new Error("fetch was not called");
    }
    const [url, init] = call as [string, RequestInit];
    return { url, init, form: init.body as FormData };
}

describe("elevenlabs-transcribe", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe("parseElevenLabsModel", () => {
        it("splits the diarize suffix off the model id", () => {
            expect(parseElevenLabsModel("scribe_v2")).toEqual({
                modelId: "scribe_v2",
                diarize: false,
            });
            expect(parseElevenLabsModel("scribe_v2+diarize")).toEqual({
                modelId: "scribe_v2",
                diarize: true,
            });
            expect(parseElevenLabsModel("  scribe_v1  ")).toEqual({
                modelId: "scribe_v1",
                diarize: false,
            });
        });
    });

    describe("resolveElevenLabsUrl", () => {
        it("defaults to the global API and accepts residency hosts", () => {
            expect(resolveElevenLabsUrl(null)).toBe(
                "https://api.elevenlabs.io/v1/speech-to-text",
            );
            expect(resolveElevenLabsUrl("")).toBe(
                "https://api.elevenlabs.io/v1/speech-to-text",
            );
            expect(
                resolveElevenLabsUrl("https://api.eu.residency.elevenlabs.io"),
            ).toBe("https://api.eu.residency.elevenlabs.io/v1/speech-to-text");
        });

        it("tolerates a trailing slash and a trailing /v1", () => {
            expect(
                resolveElevenLabsUrl("https://api.eu.residency.elevenlabs.io/"),
            ).toBe("https://api.eu.residency.elevenlabs.io/v1/speech-to-text");
            expect(
                resolveElevenLabsUrl(
                    "https://api.eu.residency.elevenlabs.io/v1/",
                ),
            ).toBe("https://api.eu.residency.elevenlabs.io/v1/speech-to-text");
        });
    });

    it("posts multipart audio with xi-api-key auth and ElevenLabs field names", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse({ text: "hello world", language_code: "en" }),
        );

        const result = await elevenLabsTranscribe({
            apiKey: "sk_test",
            model: "scribe_v2",
            file: audioFile(),
            language: "cs",
        });

        expect(result).toEqual({ text: "hello world", detectedLanguage: "en" });

        const { url, init, form } = lastRequest();
        expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
        expect(init.method).toBe("POST");
        expect(init.headers).toEqual({ "xi-api-key": "sk_test" });
        expect(form.get("model_id")).toBe("scribe_v2");
        expect(form.get("language_code")).toBe("cs");
        expect(form.get("diarize")).toBeNull();
        expect((form.get("file") as File).name).toBe("meeting.mp3");
    });

    it("omits language_code when no default language is configured", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse({ text: "no language hint", language_code: "de" }),
        );

        const result = await elevenLabsTranscribe({
            apiKey: "sk_test",
            model: "scribe_v2",
            file: audioFile(),
        });

        expect(lastRequest().form.get("language_code")).toBeNull();
        expect(result.detectedLanguage).toBe("de");
    });

    it("requests diarization and renders speaker-labelled lines", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse({
                text: "Ahoj. Dobry den.",
                language_code: "cs",
                words: [
                    { text: "Ahoj", type: "word", speaker_id: "speaker_0" },
                    { text: ".", type: "word", speaker_id: "speaker_0" },
                    { text: " ", type: "spacing", speaker_id: "speaker_0" },
                    { text: "Dobry", type: "word", speaker_id: "speaker_1" },
                    { text: " ", type: "spacing", speaker_id: "speaker_1" },
                    { text: "den", type: "word", speaker_id: "speaker_1" },
                    { text: ".", type: "word", speaker_id: "speaker_1" },
                ],
            }),
        );

        const result = await elevenLabsTranscribe({
            apiKey: "sk_test",
            model: "scribe_v2+diarize",
            file: audioFile(),
        });

        expect(lastRequest().form.get("model_id")).toBe("scribe_v2");
        expect(lastRequest().form.get("diarize")).toBe("true");
        expect(result.text).toBe("speaker_0: Ahoj.\nspeaker_1: Dobry den.");
        expect(result.detectedLanguage).toBe("cs");
    });

    it("falls back to the plain transcript when a diarized response carries no speakers", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse({
                text: "single speaker recording",
                language_code: "en",
                words: [{ text: "single", type: "word" }],
            }),
        );

        const result = await elevenLabsTranscribe({
            apiKey: "sk_test",
            model: "scribe_v2+diarize",
            file: audioFile(),
        });

        expect(result.text).toBe("single speaker recording");
    });

    it("maps a rejected key to a typed error", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse(
                { detail: { status: "invalid_api_key", message: "Bad key" } },
                401,
            ),
        );

        await expect(
            elevenLabsTranscribe({
                apiKey: "sk_wrong",
                model: "scribe_v2",
                file: audioFile(),
            }),
        ).rejects.toMatchObject({
            name: "ElevenLabsTranscribeError",
            status: 401,
            message: "ElevenLabs rejected the API key. Bad key",
        });
    });

    it("surfaces validation detail from a 422", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse(
                {
                    detail: [
                        { loc: ["body", "model_id"], msg: "model not found" },
                    ],
                },
                422,
            ),
        );

        await expect(
            elevenLabsTranscribe({
                apiKey: "sk_test",
                model: "scribe_v9",
                file: audioFile(),
            }),
        ).rejects.toThrow(/model not found/);
    });

    it("rejects an empty transcription", async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
            jsonResponse({ text: "   ", language_code: "en" }),
        );

        await expect(
            elevenLabsTranscribe({
                apiKey: "sk_test",
                model: "scribe_v2",
                file: audioFile(),
            }),
        ).rejects.toBeInstanceOf(ElevenLabsTranscribeError);
    });
});

describe("elevenLabsTranscribe turns", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns turns with millisecond timings for a diarized job", async () => {
        stubJson({
            text: "ignored",
            language_code: "cs",
            words: [
                {
                    text: "Ahoj",
                    type: "word",
                    speaker_id: "speaker_0",
                    start: 0,
                    end: 0.4,
                },
                {
                    text: " ",
                    type: "spacing",
                    speaker_id: "speaker_0",
                    start: 0.4,
                    end: 0.5,
                },
                {
                    text: "Jan",
                    type: "word",
                    speaker_id: "speaker_0",
                    start: 0.5,
                    end: 0.9,
                },
                {
                    text: "Zdravim",
                    type: "word",
                    speaker_id: "speaker_1",
                    start: 1.5,
                    end: 2.25,
                },
            ],
        });

        const result = await elevenLabsTranscribe({
            apiKey: "k",
            model: "scribe_v1+diarize",
            file: new File([new Uint8Array([1])], "a.mp3"),
        });

        expect(result.turns).toEqual([
            { speaker: "speaker_0", startMs: 0, endMs: 900, text: "Ahoj Jan" },
            {
                speaker: "speaker_1",
                startMs: 1500,
                endMs: 2250,
                text: "Zdravim",
            },
        ]);
        expectTextAndTurnsAgree(result.text, result.turns);
    });

    it("renders text and turns from the same grouping", async () => {
        stubJson({
            text: "ignored",
            language_code: "cs",
            // Spacing that extends a run, a speaker returning after an
            // interruption, and a word carrying no text -- the three places a
            // second pass over the same words would group differently.
            words: [
                spoken("Ahoj", "speaker_0", 0, 0.4),
                { ...spoken(" ", "speaker_0", 0.4, 0.5), type: "spacing" },
                spoken("Jan", "speaker_0", 0.5, 0.9),
                spoken("Zdravim", "speaker_1", 1.5, 2.25),
                spoken("", "speaker_1", 2.25, 2.3),
                spoken("Dobre", "speaker_0", 3, 3.4),
                { ...spoken(" ", "speaker_0", 3.4, 3.5), type: "spacing" },
            ],
        });

        const result = await elevenLabsTranscribe({
            apiKey: "k",
            model: "scribe_v1+diarize",
            file: new File([new Uint8Array([1])], "a.mp3"),
        });

        expectTextAndTurnsAgree(result.text, result.turns);
    });

    it("returns no turns when diarization is not requested", async () => {
        stubJson({ text: "Ahoj Jan", language_code: "cs", words: [] });

        const result = await elevenLabsTranscribe({
            apiKey: "k",
            model: "scribe_v1",
            file: new File([new Uint8Array([1])], "a.mp3"),
        });

        expect(result.turns).toBeUndefined();
    });
});

function stubJson(body: unknown): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response(JSON.stringify(body), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                }),
        ),
    );
}
