import { env } from "@/lib/env";

const DEFAULT_API_BASE = "https://api.elevenlabs.io";
const DIARIZE_SUFFIX = "+diarize";
const ERROR_DETAIL_MAX_CHARS = 200;

export interface ElevenLabsTranscribeArgs {
    apiKey: string;
    model: string;
    file: File;
    language?: string;
    baseUrl?: string | null;
}

export interface ElevenLabsTranscribeResult {
    text: string;
    detectedLanguage: string | null;
}

export class ElevenLabsTranscribeError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
        this.name = "ElevenLabsTranscribeError";
    }
}

/** ElevenLabs `model_id` plus the request flags Riffado encodes alongside it. */
export interface ParsedElevenLabsModel {
    modelId: string;
    diarize: boolean;
}

interface ElevenLabsWord {
    text?: string;
    type?: string;
    speaker_id?: string | null;
}

interface ElevenLabsTranscriptionResponse {
    text?: string;
    language_code?: string | null;
    words?: ElevenLabsWord[];
}

/**
 * Split a stored model string into the ElevenLabs `model_id` and the
 * request flags it carries. Diarization is a request parameter rather than
 * a distinct model, so the model picker offers it as a `+diarize` suffix.
 */
export function parseElevenLabsModel(model: string): ParsedElevenLabsModel {
    const trimmed = model.trim();
    if (trimmed.endsWith(DIARIZE_SUFFIX)) {
        return {
            modelId: trimmed.slice(0, -DIARIZE_SUFFIX.length),
            diarize: true,
        };
    }
    return { modelId: trimmed, diarize: false };
}

/**
 * Resolve the speech-to-text endpoint. An empty base URL targets the
 * global API; a residency host (`https://api.eu.residency.elevenlabs.io`)
 * is accepted with or without a trailing `/v1`.
 */
export function resolveElevenLabsUrl(baseUrl?: string | null): string {
    const base = (baseUrl || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
    const root = base.replace(/\/v1$/, "");
    return `${root || DEFAULT_API_BASE}/v1/speech-to-text`;
}

/**
 * Transcribe an audio file with ElevenLabs Scribe.
 *
 * Scribe is not OpenAI-compatible: the endpoint is `/v1/speech-to-text`,
 * auth is `xi-api-key`, and the multipart fields are `model_id` and
 * `language_code`. Diarized models return speaker-attributed words, which
 * are rendered as `speaker_id: text` lines to match the shape Riffado
 * already stores for OpenAI's diarizing model.
 */
export async function elevenLabsTranscribe({
    apiKey,
    model,
    file,
    language,
    baseUrl,
}: ElevenLabsTranscribeArgs): Promise<ElevenLabsTranscribeResult> {
    const { modelId, diarize } = parseElevenLabsModel(model);

    const form = new FormData();
    form.append("model_id", modelId);
    form.append("file", file, file.name);
    if (language) {
        form.append("language_code", language);
    }
    if (diarize) {
        form.append("diarize", "true");
    }

    const response = await fetch(resolveElevenLabsUrl(baseUrl), {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        signal: AbortSignal.timeout(env.WHISPER_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new ElevenLabsTranscribeError(
            response.status,
            await describeError(response),
        );
    }

    const payload = (await response.json()) as ElevenLabsTranscriptionResponse;
    const plainText = payload.text?.trim() ?? "";
    const diarizedText = diarize
        ? formatDiarizedText(payload.words ?? [])
        : null;
    const text = diarizedText ?? plainText;

    if (!text) {
        throw new ElevenLabsTranscribeError(
            response.status,
            "ElevenLabs returned an empty transcription. The audio may be silent or shorter than 100 ms.",
        );
    }

    return {
        text,
        detectedLanguage: payload.language_code || language || null,
    };
}

function formatDiarizedText(words: ElevenLabsWord[]): string | null {
    const segments: { speaker: string; text: string }[] = [];
    let sawSpeaker = false;

    for (const word of words) {
        const text = word.text ?? "";
        if (!text) {
            continue;
        }
        const last = segments.at(-1);
        if (word.type === "spacing") {
            if (last) {
                last.text += text;
            }
            continue;
        }
        const speaker = word.speaker_id || "";
        if (speaker) {
            sawSpeaker = true;
        }
        if (!last || last.speaker !== speaker) {
            segments.push({ speaker, text });
        } else {
            last.text += text;
        }
    }

    if (!sawSpeaker) {
        return null;
    }

    const lines = segments
        .map((segment) => ({
            speaker: segment.speaker || "speaker",
            text: segment.text.trim(),
        }))
        .filter((segment) => segment.text.length > 0)
        .map((segment) => `${segment.speaker}: ${segment.text}`);

    return lines.length > 0 ? lines.join("\n") : null;
}

async function describeError(response: Response): Promise<string> {
    const body = await response.text().catch(() => "");
    const detail = parseErrorDetail(body);
    const suffix = detail ? ` ${detail}` : "";

    switch (response.status) {
        case 401:
        case 403:
            return `ElevenLabs rejected the API key.${suffix}`;
        case 413:
            return `ElevenLabs rejected the recording as too large.${suffix}`;
        case 422:
            return `ElevenLabs rejected the request. Check the model id and language code.${suffix}`;
        case 429:
            return `ElevenLabs rate limit reached.${suffix}`;
        default:
            return `ElevenLabs returned ${response.status}.${suffix}`;
    }
}

function parseErrorDetail(body: string): string | null {
    if (!body) {
        return null;
    }
    try {
        const parsed = JSON.parse(body) as { detail?: unknown };
        const detail = parsed.detail;
        if (typeof detail === "string") {
            return detail;
        }
        if (Array.isArray(detail)) {
            const messages = detail
                .map((entry) => (entry as { msg?: unknown }).msg)
                .filter((msg): msg is string => typeof msg === "string");
            return messages.length > 0 ? messages.join("; ") : null;
        }
        if (detail && typeof detail === "object") {
            const message = (detail as { message?: unknown }).message;
            return typeof message === "string" ? message : null;
        }
        return null;
    } catch {
        return body.slice(0, ERROR_DETAIL_MAX_CHARS);
    }
}
