import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        WHISPER_REQUEST_TIMEOUT_MS: 60 * 60 * 1000,
    },
}));

import {
    buildSpeechmaticsConfig,
    parseSpeechmaticsModel,
    resolveSpeechmaticsBase,
    SpeechmaticsTranscribeError,
    speechmaticsTranscribe,
} from "@/lib/transcription/speechmatics-transcribe";
import { renderTurnsAsText } from "@/lib/transcription/turns";

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

/** One `results` entry in the shape `format=json-v2` returns. */
function word(
    content: string,
    extra: {
        speaker?: string;
        language?: string;
        start?: number;
        end?: number;
    } = {},
) {
    const { start = 0, end = 0, ...alt } = extra;
    return {
        type: "word",
        start_time: start,
        end_time: end,
        alternatives: [{ content, confidence: 0.9, ...alt }],
    };
}

function punctuation(
    content: string,
    extra: {
        speaker?: string;
        attaches_to?: string;
        start?: number;
        end?: number;
    } = {},
) {
    const { attaches_to = "previous", start = 0, end = 0, ...alt } = extra;
    return {
        type: "punctuation",
        attaches_to,
        start_time: start,
        end_time: end,
        alternatives: [{ content, confidence: 1, ...alt }],
    };
}

interface Handlers {
    submit?: () => Response;
    /** Called once per poll, zero-indexed. */
    poll?: (attempt: number) => Response;
    transcript?: () => Response;
}

interface Recorded {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

const calls: Recorded[] = [];

function installFetch(handlers: Handlers): void {
    let polls = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit = {}) => {
            const method = init.method ?? "GET";
            calls.push({
                url,
                method,
                headers: (init.headers ?? {}) as Record<string, string>,
                body: init.body,
            });

            if (method === "POST") {
                return (
                    handlers.submit?.() ?? jsonResponse({ id: "job-abc" }, 201)
                );
            }
            if (method === "DELETE") {
                return jsonResponse({});
            }
            if (url.includes("/transcript")) {
                return (
                    handlers.transcript?.() ??
                    jsonResponse({ results: [word("hello")] })
                );
            }
            return (
                handlers.poll?.(polls++) ??
                jsonResponse({ job: { status: "done" } })
            );
        }),
    );
}

function callsTo(fragment: string, method?: string): Recorded[] {
    return calls.filter(
        (call) =>
            call.url.includes(fragment) &&
            (method === undefined || call.method === method),
    );
}

async function transcribe(overrides: Record<string, unknown> = {}) {
    return speechmaticsTranscribe({
        apiKey: "sm-key",
        model: "enhanced",
        file: audioFile(),
        language: "cs",
        baseUrl: null,
        // The poll loop is the point of several of these tests; never let
        // it actually sleep.
        pollIntervalMs: 0,
        ...overrides,
    });
}

describe("speechmatics-transcribe", () => {
    beforeEach(() => {
        calls.length = 0;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe("parseSpeechmaticsModel", () => {
        it("splits the diarize suffix off the model name", () => {
            expect(parseSpeechmaticsModel("enhanced")).toEqual({
                modelId: "enhanced",
                diarize: false,
            });
            expect(parseSpeechmaticsModel("enhanced+diarize")).toEqual({
                modelId: "enhanced",
                diarize: true,
            });
            expect(parseSpeechmaticsModel("  melia-1  ")).toEqual({
                modelId: "melia-1",
                diarize: false,
            });
        });
    });

    describe("resolveSpeechmaticsBase", () => {
        it("defaults to the auto-routing host and accepts regional ones", () => {
            expect(resolveSpeechmaticsBase(null)).toBe(
                "https://asr.api.speechmatics.com/v2",
            );
            expect(resolveSpeechmaticsBase("")).toBe(
                "https://asr.api.speechmatics.com/v2",
            );
            expect(
                resolveSpeechmaticsBase("https://eu2.asr.api.speechmatics.com"),
            ).toBe("https://eu2.asr.api.speechmatics.com/v2");
        });

        it("tolerates a trailing slash and a trailing /v2", () => {
            expect(
                resolveSpeechmaticsBase(
                    "https://us1.asr.api.speechmatics.com/",
                ),
            ).toBe("https://us1.asr.api.speechmatics.com/v2");
            expect(
                resolveSpeechmaticsBase(
                    "https://us1.asr.api.speechmatics.com/v2",
                ),
            ).toBe("https://us1.asr.api.speechmatics.com/v2");
        });
    });

    describe("buildSpeechmaticsConfig", () => {
        it("carries the model and the configured language", () => {
            expect(
                JSON.parse(
                    buildSpeechmaticsConfig({
                        modelId: "enhanced",
                        diarize: false,
                        language: "cs",
                    }),
                ),
            ).toEqual({
                type: "transcription",
                transcription_config: { model: "enhanced", language: "cs" },
            });
        });

        it("falls back to language identification when none is configured", () => {
            const config = JSON.parse(
                buildSpeechmaticsConfig({
                    modelId: "standard",
                    diarize: false,
                    language: undefined,
                }),
            );
            expect(config.transcription_config.language).toBe("auto");
        });

        it("forces `multi` for Melia, which refuses a concrete code", () => {
            const config = JSON.parse(
                buildSpeechmaticsConfig({
                    modelId: "melia-1",
                    diarize: true,
                    language: "cs",
                }),
            );
            expect(config.transcription_config).toEqual({
                model: "melia-1",
                language: "multi",
                diarization: "speaker",
            });
        });
    });

    it("submits, polls to done, and downloads the json-v2 transcript", async () => {
        installFetch({
            poll: (attempt) =>
                jsonResponse({
                    job: { status: attempt === 0 ? "running" : "done" },
                }),
            transcript: () =>
                jsonResponse({
                    metadata: {
                        language_pack_info: { word_delimiter: " " },
                        transcription_config: { language: "cs" },
                    },
                    results: [
                        word("Dobry"),
                        word("den"),
                        punctuation(","),
                        word("kolegove"),
                        punctuation("."),
                    ],
                }),
        });

        const result = await transcribe();

        expect(result.text).toBe("Dobry den, kolegove.");
        expect(result.detectedLanguage).toBe("cs");

        const [submit] = callsTo("/v2/jobs", "POST");
        expect(submit.url).toBe("https://asr.api.speechmatics.com/v2/jobs");
        expect(submit.headers).toEqual({ Authorization: "Bearer sm-key" });
        const form = submit.body as FormData;
        expect((form.get("data_file") as File).name).toBe("meeting.mp3");
        expect(JSON.parse(form.get("config") as string)).toEqual({
            type: "transcription",
            transcription_config: { model: "enhanced", language: "cs" },
        });

        // Two polls: the first saw `running`.
        expect(
            calls.filter(
                (call) =>
                    call.method === "GET" && !call.url.includes("/transcript"),
            ),
        ).toHaveLength(2);

        const [transcript] = callsTo("/transcript");
        expect(transcript.url).toBe(
            "https://asr.api.speechmatics.com/v2/jobs/job-abc/transcript?format=json-v2",
        );
    });

    it("deletes the job once the transcript is in hand", async () => {
        installFetch({});
        await transcribe();

        const [removed] = callsTo("/v2/jobs/job-abc", "DELETE");
        expect(removed.url).toBe(
            "https://asr.api.speechmatics.com/v2/jobs/job-abc",
        );
        expect(removed.headers).toEqual({ Authorization: "Bearer sm-key" });
    });

    it("honours a regional base URL stored on the credential", async () => {
        installFetch({});
        await transcribe({ baseUrl: "https://eu2.asr.api.speechmatics.com" });

        expect(callsTo("/v2/jobs", "POST")[0].url).toBe(
            "https://eu2.asr.api.speechmatics.com/v2/jobs",
        );
    });

    it("renders speaker turns as speaker_N lines when diarizing", async () => {
        installFetch({
            transcript: () =>
                jsonResponse({
                    results: [
                        word("Ahoj", { speaker: "S1" }),
                        punctuation(".", { speaker: "S1" }),
                        word("Ahoj", { speaker: "S2" }),
                        word("taky", { speaker: "S2" }),
                        punctuation("!", { speaker: "S2" }),
                        word("Zacneme", { speaker: "S1" }),
                    ],
                }),
        });

        const result = await transcribe({ model: "enhanced+diarize" });

        expect(result.text).toBe(
            "speaker_1: Ahoj.\nspeaker_2: Ahoj taky!\nspeaker_1: Zacneme",
        );
        const form = callsTo("/v2/jobs", "POST")[0].body as FormData;
        expect(
            JSON.parse(form.get("config") as string).transcription_config
                .diarization,
        ).toBe("speaker");
    });

    it("returns turns with millisecond timings for a diarized job", async () => {
        installFetch({
            transcript: () =>
                jsonResponse({
                    results: [
                        word("Ahoj", { speaker: "S1", start: 0, end: 0.5 }),
                        punctuation(".", {
                            speaker: "S1",
                            start: 0.5,
                            end: 0.5,
                        }),
                        word("Ahoj", { speaker: "S2", start: 1.2, end: 1.8 }),
                        word("taky", { speaker: "S2", start: 1.8, end: 2.4 }),
                        word("Zacneme", {
                            speaker: "S1",
                            start: 3.1,
                            end: 3.95,
                        }),
                    ],
                }),
        });

        const result = await transcribe({ model: "enhanced+diarize" });

        expect(result.turns).toEqual([
            { speaker: "speaker_1", startMs: 0, endMs: 500, text: "Ahoj." },
            {
                speaker: "speaker_2",
                startMs: 1200,
                endMs: 2400,
                text: "Ahoj taky",
            },
            {
                speaker: "speaker_1",
                startMs: 3100,
                endMs: 3950,
                text: "Zacneme",
            },
        ]);
    });

    it("renders text and turns from the same grouping", async () => {
        installFetch({
            transcript: () =>
                jsonResponse({
                    results: [
                        word("Ahoj", { speaker: "S1", start: 0, end: 0.5 }),
                        word("Zdravim", { speaker: "S2", start: 1, end: 1.5 }),
                    ],
                }),
        });

        const result = await transcribe({ model: "enhanced+diarize" });

        expect(renderTurnsAsText(result.turns ?? [])).toBe(result.text);
    });

    it("returns no turns for an undiarized job", async () => {
        installFetch({
            transcript: () =>
                jsonResponse({ results: [word("Ahoj", { start: 0, end: 1 })] }),
        });

        const result = await transcribe({ model: "enhanced" });

        expect(result.turns).toBeUndefined();
    });

    it("falls back to plain text when diarization attributed nothing", async () => {
        installFetch({
            transcript: () =>
                jsonResponse({
                    results: [
                        word("Sole", { speaker: "UU" }),
                        word("voice", { speaker: "UU" }),
                        punctuation(".", { speaker: "UU" }),
                    ],
                }),
        });

        const result = await transcribe({ model: "standard+diarize" });

        expect(result.text).toBe("Sole voice.");
    });

    it("uses the language pack's word delimiter, which is empty for Mandarin", async () => {
        installFetch({
            transcript: () =>
                jsonResponse({
                    metadata: { language_pack_info: { word_delimiter: "" } },
                    results: [word("你好"), word("世界"), punctuation("。")],
                }),
        });

        const result = await transcribe({ language: "cmn" });

        expect(result.text).toBe("你好世界。");
    });

    it("reports the language most of the transcript was recognised in", async () => {
        installFetch({
            transcript: () =>
                jsonResponse({
                    metadata: { transcription_config: { language: "auto" } },
                    results: [
                        word("Bonjour", { language: "fr" }),
                        word("tout", { language: "fr" }),
                        word("hello", { language: "en" }),
                    ],
                }),
        });

        const result = await transcribe({ language: undefined });

        expect(result.detectedLanguage).toBe("fr");
    });

    it("keeps polling through a 429 instead of failing the transcription", async () => {
        installFetch({
            poll: (attempt) =>
                attempt === 0
                    ? jsonResponse({ error: "Too Many Requests" }, 429)
                    : jsonResponse({ job: { status: "done" } }),
        });

        await expect(transcribe()).resolves.toMatchObject({ text: "hello" });
    });

    it("surfaces a rejected job with the reason Speechmatics gave", async () => {
        installFetch({
            poll: () =>
                jsonResponse({
                    job: {
                        status: "rejected",
                        errors: [{ message: "Unsupported audio format" }],
                    },
                }),
        });

        await expect(transcribe()).rejects.toThrow(
            /rejected the recording\. Unsupported audio format/,
        );
        await expect(transcribe()).rejects.toBeInstanceOf(
            SpeechmaticsTranscribeError,
        );
    });

    it("maps a rejected key to a typed error", async () => {
        installFetch({
            submit: () =>
                jsonResponse({ code: 401, error: "Unauthorized" }, 401),
        });

        await expect(transcribe()).rejects.toThrow(
            "Speechmatics rejected the API key. Unauthorized",
        );
    });

    it("explains a 403 entitlement failure with both fields of the body", async () => {
        installFetch({
            submit: () =>
                jsonResponse(
                    {
                        code: 403,
                        error: "Forbidden",
                        detail: "Entitlement check failed",
                    },
                    403,
                ),
        });

        await expect(transcribe()).rejects.toThrow(
            /Forbidden: Entitlement check failed/,
        );
    });

    it("rejects an empty transcription", async () => {
        installFetch({ transcript: () => jsonResponse({ results: [] }) });

        await expect(transcribe()).rejects.toThrow(/empty transcription/);
    });

    it("fails loudly when the upload is accepted but carries no job id", async () => {
        installFetch({ submit: () => jsonResponse({}, 201) });

        await expect(transcribe()).rejects.toThrow(/no job id/);
    });
});
