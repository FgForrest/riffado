import { env } from "@/lib/env";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/**
 * Speechmatics Batch speech-to-text.
 *
 * Every other adapter in this directory is one request in, one transcript
 * out. Speechmatics Batch is a *job* API: `POST /v2/jobs` uploads the
 * audio and returns an id, the job then sits in `running` until the ASR
 * finishes, and the transcript is a separate `GET`. The whole dance is
 * hidden behind one awaited call so `transcribe-recording.ts` keeps the
 * shape it already has for the synchronous providers.
 *
 * Blocking the worker for the length of a job is not a new cost: the
 * Whisper path already holds a request open for up to
 * `WHISPER_REQUEST_TIMEOUT_MS` (60 min by default), and that same budget
 * is what bounds the poll loop here.
 */

/**
 * The SDK's own default host, which routes to the nearest region.
 * Pin a region by setting Base URL on the credential -- see
 * `resolveSpeechmaticsBase`.
 */
const DEFAULT_API_BASE = "https://asr.api.speechmatics.com";

const DIARIZE_SUFFIX = "+diarize";

/** Matches the official clients, and stays clear of the 1 req/s advice. */
const POLL_INTERVAL_MS = 3_000;

/** Per-request ceiling for the small calls (submit, poll, fetch). */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Melia is multilingual and does its own language detection, but it
 * refuses a concrete language code -- the config has to say `multi`.
 */
const MELIA_LANGUAGE = "multi";

/** Language identification, for the models that support it. */
const AUTO_LANGUAGE = "auto";

/** Speechmatics' label for "diarization could not attribute this word". */
const UNKNOWN_SPEAKER = "UU";

const ERROR_DETAIL_MAX_CHARS = 200;

export interface SpeechmaticsTranscribeArgs {
    apiKey: string;
    model: string;
    file: File;
    language?: string;
    baseUrl?: string | null;
    /** Overridden in tests so the poll loop doesn't actually sleep. */
    pollIntervalMs?: number;
}

export interface SpeechmaticsTranscribeResult {
    text: string;
    detectedLanguage: string | null;
    /** Present only for a diarized job that attributed at least one word. */
    turns?: TranscriptTurn[];
}

export class SpeechmaticsTranscribeError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
        this.name = "SpeechmaticsTranscribeError";
    }
}

/** A Speechmatics model name plus the request flags Riffado encodes with it. */
export interface ParsedSpeechmaticsModel {
    modelId: string;
    diarize: boolean;
}

interface SpeechmaticsAlternative {
    content?: string;
    language?: string | null;
    speaker?: string | null;
}

interface SpeechmaticsResultItem {
    type?: string;
    attaches_to?: string;
    /** Seconds from the start of the audio. Mandatory in `json-v2`. */
    start_time?: number;
    end_time?: number;
    alternatives?: SpeechmaticsAlternative[];
}

interface SpeechmaticsTranscript {
    results?: SpeechmaticsResultItem[];
    metadata?: {
        language_pack_info?: { word_delimiter?: string };
        transcription_config?: { language?: string };
    };
}

interface SpeechmaticsJob {
    status?: string;
    errors?: { message?: string; timestamp?: string }[];
}

/**
 * Split a stored model string into the Speechmatics model name and the
 * request flags it carries. Diarization is a config field rather than a
 * distinct model, so the picker offers it as a `+diarize` suffix -- the
 * same convention the ElevenLabs preset uses, and the substring
 * `mayBeDiarized` keys the dialog rendering on.
 */
export function parseSpeechmaticsModel(model: string): ParsedSpeechmaticsModel {
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
 * Resolve the Jobs API root. An empty base URL targets the auto-routing
 * host; a regional host (`https://eu2.asr.api.speechmatics.com`) is
 * accepted with or without a trailing `/v2`.
 */
export function resolveSpeechmaticsBase(baseUrl?: string | null): string {
    const base = (baseUrl || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
    const root = base.replace(/\/v2$/, "");
    return `${root || DEFAULT_API_BASE}/v2`;
}

/**
 * Build the `config` part of the multipart submission.
 *
 * `language` is mandatory on Speechmatics' side, so a user who never set
 * a default transcription language gets `auto` (batch-only language
 * identification) rather than a silent failure. Melia is the exception:
 * it detects languages itself and only accepts `multi`.
 */
export function buildSpeechmaticsConfig({
    modelId,
    diarize,
    language,
}: {
    modelId: string;
    diarize: boolean;
    language?: string;
}): string {
    const isMelia = modelId.toLowerCase().startsWith("melia");
    const transcriptionConfig: Record<string, string> = {
        language: isMelia ? MELIA_LANGUAGE : language || AUTO_LANGUAGE,
    };
    if (modelId) {
        transcriptionConfig.model = modelId;
    }
    if (diarize) {
        transcriptionConfig.diarization = "speaker";
    }
    return JSON.stringify({
        type: "transcription",
        transcription_config: transcriptionConfig,
    });
}

/**
 * Transcribe an audio file with the Speechmatics Batch API.
 *
 * Submits the job, polls it to a terminal state, downloads the `json-v2`
 * transcript and renders it. Diarized jobs come back as `speaker_1: text`
 * lines to match the shape Riffado already stores for OpenAI's and
 * ElevenLabs' diarizing models.
 */
export async function speechmaticsTranscribe({
    apiKey,
    model,
    file,
    language,
    baseUrl,
    pollIntervalMs = POLL_INTERVAL_MS,
}: SpeechmaticsTranscribeArgs): Promise<SpeechmaticsTranscribeResult> {
    const { modelId, diarize } = parseSpeechmaticsModel(model);
    const base = resolveSpeechmaticsBase(baseUrl);
    const auth = { Authorization: `Bearer ${apiKey}` };
    const deadline = Date.now() + env.WHISPER_REQUEST_TIMEOUT_MS;

    const form = new FormData();
    form.append("data_file", file, file.name);
    form.append(
        "config",
        buildSpeechmaticsConfig({ modelId, diarize, language }),
    );

    const created = await fetch(`${base}/jobs`, {
        method: "POST",
        headers: auth,
        body: form,
        signal: AbortSignal.timeout(env.WHISPER_REQUEST_TIMEOUT_MS),
    });
    if (!created.ok) {
        throw new SpeechmaticsTranscribeError(
            created.status,
            await describeError(created),
        );
    }
    const jobId = ((await created.json()) as { id?: string }).id;
    if (!jobId) {
        throw new SpeechmaticsTranscribeError(
            created.status,
            "Speechmatics accepted the upload but returned no job id.",
        );
    }

    await waitForJob({ base, jobId, auth, deadline, pollIntervalMs });

    const transcriptResponse = await fetch(
        `${base}/jobs/${encodeURIComponent(jobId)}/transcript?format=json-v2`,
        { headers: auth, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!transcriptResponse.ok) {
        throw new SpeechmaticsTranscribeError(
            transcriptResponse.status,
            await describeError(transcriptResponse),
        );
    }
    const payload = (await transcriptResponse.json()) as SpeechmaticsTranscript;

    // The audio and its transcript stay on Speechmatics' servers until
    // their retention window expires. Riffado already has what it needs,
    // so ask for the job to go now. Best-effort: a failed cleanup must
    // not fail a transcription the user is waiting on.
    void deleteJob({ base, jobId, auth });

    const results = payload.results ?? [];
    const delimiter = payload.metadata?.language_pack_info?.word_delimiter;
    const diarized = diarize ? renderDiarized(results, delimiter) : null;
    const text = diarized?.text ?? renderPlain(results, delimiter);

    if (!text) {
        throw new SpeechmaticsTranscribeError(
            transcriptResponse.status,
            "Speechmatics returned an empty transcription. The audio may be silent or contain no speech.",
        );
    }

    return {
        text,
        detectedLanguage:
            dominantLanguage(results) ??
            configuredLanguage(payload) ??
            (language || null),
        ...(diarized ? { turns: diarized.turns } : {}),
    };
}

/**
 * Poll `GET /v2/jobs/{id}` until the job leaves `running`.
 *
 * A 429 or a 5xx here is transient -- the job is still being worked on --
 * so those keep the loop going instead of failing a transcription that is
 * about to succeed. Anything else is a real error.
 */
async function waitForJob({
    base,
    jobId,
    auth,
    deadline,
    pollIntervalMs,
}: {
    base: string;
    jobId: string;
    auth: Record<string, string>;
    deadline: number;
    pollIntervalMs: number;
}): Promise<void> {
    const url = `${base}/jobs/${encodeURIComponent(jobId)}`;

    while (true) {
        const response = await fetch(url, {
            headers: auth,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
            const job = ((await response.json()) as { job?: SpeechmaticsJob })
                .job;
            const status = job?.status ?? "running";
            if (status === "done") {
                return;
            }
            if (status !== "running") {
                throw new SpeechmaticsTranscribeError(
                    response.status,
                    describeTerminalJob(status, job),
                );
            }
        } else if (response.status !== 429 && response.status < 500) {
            throw new SpeechmaticsTranscribeError(
                response.status,
                await describeError(response),
            );
        } else {
            // Drain the body so the connection can be reused.
            await response.text().catch(() => "");
        }

        if (Date.now() + pollIntervalMs >= deadline) {
            throw new SpeechmaticsTranscribeError(
                504,
                `Speechmatics job ${jobId} did not finish within ${Math.round(
                    env.WHISPER_REQUEST_TIMEOUT_MS / 60_000,
                )} minutes. Raise WHISPER_REQUEST_TIMEOUT_MS or retry.`,
            );
        }
        await sleep(pollIntervalMs);
    }
}

async function deleteJob({
    base,
    jobId,
    auth,
}: {
    base: string;
    jobId: string;
    auth: Record<string, string>;
}): Promise<void> {
    try {
        await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`, {
            method: "DELETE",
            headers: auth,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch {
        // Retention on Speechmatics' side will collect it instead.
    }
}

function sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Flatten `json-v2` results into one string.
 *
 * Punctuation carries `attaches_to`, so a comma sticks to the word before
 * it and an opening quote to the word after. The separator between words
 * is the language pack's own `word_delimiter`, which is a space for most
 * languages and an empty string for the ones that don't space their words
 * (Mandarin, Japanese).
 */
function renderPlain(
    results: SpeechmaticsResultItem[],
    wordDelimiter: string | undefined,
): string {
    const delimiter = wordDelimiter ?? " ";
    let out = "";
    let needsDelimiter = false;

    for (const item of results) {
        const content = item.alternatives?.[0]?.content ?? "";
        if (!content) continue;

        const attaches =
            item.type === "punctuation"
                ? (item.attaches_to ?? "previous")
                : null;
        if (out && needsDelimiter && attaches !== "previous") {
            out += delimiter;
        }
        out += content;
        needsDelimiter = attaches !== "next";
    }

    return out.trim();
}

/**
 * Render speaker-attributed results as `speaker_1: text` lines, or null
 * when the job came back with no attributions at all -- a diarized job
 * that found a single voice labels everything `UU`, and a dialog with one
 * anonymous participant is worse than plain prose.
 */
function renderDiarized(
    results: SpeechmaticsResultItem[],
    wordDelimiter: string | undefined,
): { text: string; turns: TranscriptTurn[] } | null {
    const turns: { speaker: string; items: SpeechmaticsResultItem[] }[] = [];
    let sawSpeaker = false;

    for (const item of results) {
        if (!item.alternatives?.[0]?.content) continue;
        const speaker = normalizeSpeaker(item.alternatives[0].speaker);
        if (speaker) {
            sawSpeaker = true;
        }
        const last = turns.at(-1);
        // Punctuation inherits the turn it trails, so a full stop never
        // opens a turn of its own.
        if (last && (last.speaker === speaker || item.type === "punctuation")) {
            last.items.push(item);
        } else {
            turns.push({ speaker, items: [item] });
        }
    }

    if (!sawSpeaker) {
        return null;
    }

    const rendered = turns
        .map((turn) => ({
            speaker: turn.speaker || "speaker",
            text: renderPlain(turn.items, wordDelimiter),
            startMs: toMs(turn.items[0]?.start_time),
            endMs: turn.items.reduce(
                (latest, item) => Math.max(latest, toMs(item.end_time)),
                0,
            ),
        }))
        .filter((turn) => turn.text.length > 0);

    if (rendered.length === 0) {
        return null;
    }

    return {
        text: rendered
            .map((turn) => `${turn.speaker}: ${turn.text}`)
            .join("\n"),
        turns: rendered.map(({ speaker, text, startMs, endMs }) => ({
            speaker,
            text,
            startMs,
            endMs,
        })),
    };
}

/** Seconds to whole milliseconds; a missing time is the start of the audio. */
function toMs(seconds: number | undefined): number {
    return Math.round((seconds ?? 0) * 1000);
}

/**
 * Map Speechmatics' `S1` onto the `speaker_1` form the rest of Riffado
 * stores, so the workstation renders "Speaker 1" for every diarizing
 * provider rather than "S1" for this one. Names from speaker
 * identification are passed through untouched; `UU` means unattributed
 * and is reported as no speaker at all.
 */
function normalizeSpeaker(raw: string | null | undefined): string {
    const speaker = (raw ?? "").trim();
    if (!speaker || speaker === UNKNOWN_SPEAKER) {
        return "";
    }
    const numbered = /^S(\d+)$/.exec(speaker);
    return numbered ? `speaker_${numbered[1]}` : speaker;
}

/**
 * The language most of the transcript was recognised in. Per-word, because
 * that is where language identification reports it, and most-frequent
 * rather than first so one foreign opening line doesn't relabel the whole
 * recording.
 */
function dominantLanguage(results: SpeechmaticsResultItem[]): string | null {
    const counts = new Map<string, number>();
    for (const item of results) {
        const language = item.alternatives?.[0]?.language;
        if (!language) continue;
        counts.set(language, (counts.get(language) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [language, count] of counts) {
        if (count > bestCount) {
            best = language;
            bestCount = count;
        }
    }
    return best;
}

/** The language echoed back in the job config, unless it's a detect mode. */
function configuredLanguage(payload: SpeechmaticsTranscript): string | null {
    const language = payload.metadata?.transcription_config?.language;
    if (
        !language ||
        language === AUTO_LANGUAGE ||
        language === MELIA_LANGUAGE
    ) {
        return null;
    }
    return language;
}

function describeTerminalJob(status: string, job?: SpeechmaticsJob): string {
    const detail = (job?.errors ?? [])
        .map((error) => error.message)
        .filter((message): message is string => Boolean(message))
        .join("; ");
    const suffix = detail ? ` ${detail}` : "";

    if (status === "rejected") {
        return `Speechmatics rejected the recording.${suffix || " The audio format may be unsupported, or the account may be out of credit."}`;
    }
    if (status === "expired" || status === "deleted") {
        return `Speechmatics reports the job as ${status} before its transcript could be fetched.${suffix}`;
    }
    return `Speechmatics returned an unexpected job status "${status}".${suffix}`;
}

async function describeError(response: Response): Promise<string> {
    const body = await response.text().catch(() => "");
    const detail = parseErrorDetail(body);
    const suffix = detail ? ` ${detail}` : "";

    switch (response.status) {
        case 401:
            return `Speechmatics rejected the API key.${suffix}`;
        case 403:
            return `Speechmatics refused the request. The key may be expired, or the plan may not include the requested feature.${suffix}`;
        case 404:
            return `Speechmatics could not find the job. It may have expired.${suffix}`;
        case 413:
            return `Speechmatics rejected the recording as too large.${suffix}`;
        case 429:
            return `Speechmatics rate limit reached.${suffix}`;
        default:
            return `Speechmatics returned ${response.status}.${suffix}`;
    }
}

function parseErrorDetail(body: string): string | null {
    if (!body) {
        return null;
    }
    try {
        const parsed = JSON.parse(body) as {
            detail?: unknown;
            error?: unknown;
        };
        const parts = [parsed.error, parsed.detail]
            .filter((part): part is string => typeof part === "string")
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
        // `{"code":403,"error":"Forbidden","detail":"Entitlement check failed"}`
        // reads best as "Forbidden: Entitlement check failed".
        return parts.length > 0 ? parts.join(": ") : null;
    } catch {
        return body.slice(0, ERROR_DETAIL_MAX_CHARS);
    }
}
