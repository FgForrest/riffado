/**
 * Detecting the topics of one transcript and storing them on it.
 *
 * Topics are written onto the transcript row itself, so they follow the
 * writer rule: the owner detects them on the private view, and while the
 * recording is shared the organization account on the Organization view.
 * The prompt and output language follow the view, and the provider is the
 * actor's, who pays (`resolveRunContext`); the row is the owner's either
 * way, as a shared recording is one recording.
 */

import { and, eq, isNull } from "drizzle-orm";
import { OpenAI } from "openai";
import { db } from "@/db";
import {
    apiCredentials,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { buildChatCompletionParams } from "@/lib/ai/chat-completion-params";
import { CONTENT_IS_DATA_DIRECTIVE } from "@/lib/ai/content-directive";
import {
    enhancementChatModel,
    pickTopicsCredential,
} from "@/lib/ai/enhancement-provider";
import { resolveTemplate } from "@/lib/ai/prompt-templates";
import { getAiOutputLanguageDirective } from "@/lib/ai/summary-presets";
import { topicsProviderId } from "@/lib/ai/topics-provider";
import { recordChatCompletionUsage } from "@/lib/ai/usage-cost";
import { decrypt } from "@/lib/encryption";
import { decryptJsonField, encryptJsonField } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { retryWithBackoff } from "@/lib/jobs/backoff";
import { isRetryableError } from "@/lib/jobs/retryable";
import type { JobProgress } from "@/lib/jobs/types";
import { modelInput } from "@/lib/learn/llm-input";
import { captureServerEvent } from "@/lib/posthog-server";
import { resolveRunContext } from "@/lib/sharing/run-context";
import type { RecordingView } from "@/lib/sharing/view";
import {
    contentWriterRefusal,
    contentWriterRefusalNow,
    sharingOrgUserId,
    writerRefusalError,
} from "@/lib/sharing/writer";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import {
    anchorTopics,
    finishTopics,
    joinWindowTopics,
    parseTopicsReply,
} from "./anchor";
import type { StoredTopics } from "./stored-topics";
import {
    buildTimeMarks,
    renderTimedTranscript,
    splitIntoWindows,
    type TranscriptTopic,
} from "./timeline";
import {
    normalizeTopicPromptConfig,
    TOPIC_SYSTEM_PROMPT,
    TOPIC_TEMPLATE_KIND,
} from "./topic-presets";

/** Transcript sources topics can be detected on. */
export type TopicSource = "plaud" | "riffado";

/**
 * Transcript per request, in rendered characters (about 10k tokens), and how
 * much consecutive requests share. Sized for the smaller context windows of
 * the OpenAI-compatible models people run themselves, not for the largest.
 */
const WINDOW_CHARS = 40_000;
const WINDOW_OVERLAP_CHARS = 4_000;

const CALL_RETRY_ATTEMPTS = 3;
const CALL_RETRY_BASE_MS = 1_500;
const CALL_RETRY_MAX_MS = 15_000;

export interface GenerateTopicsOptions {
    trigger: "manual" | "auto";
    onProgress?: (progress: JobProgress) => void;
    view?: RecordingView;
}

export interface GenerateTopicsResult {
    topics: TranscriptTopic[];
    provider: string;
    model: string;
    templateId: string;
    windows: number;
}

export async function generateTopicsForTranscript(
    actorUserId: string,
    recordingId: string,
    source: TopicSource,
    opts: GenerateTopicsOptions,
): Promise<GenerateTopicsResult> {
    const ctx = await resolveRunContext(
        actorUserId,
        recordingId,
        opts.view ?? "private",
    );
    if (!ctx) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    // The owner's rows in either view.
    const userId = ctx.ownerUserId;
    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    // Refused before the provider is paid, and again under the lock where
    // the topics are written.
    const refusal = await contentWriterRefusalNow({
        recordingId,
        ownerUserId: userId,
        actorUserId: ctx.actorUserId,
    });
    if (refusal) throw writerRefusalError(refusal);

    const [transcript] = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, source),
            ),
        )
        .limit(1);
    if (!transcript) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "This recording has no such transcript",
            400,
        );
    }
    const turns = readTranscriptTurns(transcript);
    if (!turns) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "This transcript has no timings, so topics cannot be detected on it",
            400,
        );
    }

    // The prompt and language follow the view.
    const [settings] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, ctx.settingsUserId))
        .limit(1);
    const promptConfig = normalizeTopicPromptConfig(
        settings?.topicPrompt ? decryptJsonField(settings.topicPrompt) : null,
    );
    const { id: templateId, prompt: promptTemplate } = resolveTemplate(
        promptConfig,
        promptConfig.selectedPrompt,
        TOPIC_TEMPLATE_KIND,
    );

    // The provider is the actor's, who pays.
    const configured = await db
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, ctx.actorUserId));
    const [providerSettings] =
        ctx.actorUserId === ctx.settingsUserId
            ? [settings]
            : await db
                  .select({ defaultProviders: userSettings.defaultProviders })
                  .from(userSettings)
                  .where(eq(userSettings.userId, ctx.actorUserId))
                  .limit(1);
    const credentials = pickTopicsCredential(
        configured,
        topicsProviderId(providerSettings?.defaultProviders),
    );
    if (!credentials) {
        throw new AppError(
            ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
            configured.length > 0
                ? "Your AI providers are transcription only. Add an OpenAI-compatible provider to detect topics."
                : "No AI provider configured",
            400,
        );
    }
    const openai = new OpenAI({
        apiKey: decrypt(credentials.apiKey),
        baseURL: credentials.baseUrl || undefined,
    });
    const model = enhancementChatModel(credentials);

    const systemContent = [
        TOPIC_SYSTEM_PROMPT,
        CONTENT_IS_DATA_DIRECTIVE,
        getAiOutputLanguageDirective(settings?.aiOutputLanguage ?? null),
    ].join("\n\n");

    // Read with its corrections applied (same turns, same times), and the
    // fingerprint of that kept with the topics.
    const input = await modelInput(transcript);
    const readTurns = input.turns ?? turns;
    // Inner marks follow the words as heard, which the audio's times do.
    const marks = buildTimeMarks(readTurns, { toHeard: input.toHeard });
    const endMs = Math.max(...readTurns.map((turn) => turn.endMs));
    const windows = splitIntoWindows(marks, WINDOW_CHARS, WINDOW_OVERLAP_CHARS);

    const topicsPerWindow: TranscriptTopic[][] = [];
    for (const [index, window] of windows.entries()) {
        opts.onProgress?.({
            phase: "windows",
            completed: index,
            total: windows.length,
        });
        const timed = renderTimedTranscript(window.marks);
        const part =
            windows.length > 1
                ? `\n\nThis is part ${index + 1} of ${windows.length} of a longer transcript. Its first topic may continue from the previous part.`
                : "";
        const prompt =
            promptTemplate.replaceAll("{transcription}", () => timed) + part;

        const reply = await retryWithBackoff({
            attempts: CALL_RETRY_ATTEMPTS,
            baseMs: CALL_RETRY_BASE_MS,
            maxMs: CALL_RETRY_MAX_MS,
            jitter: 0.5,
            isRetryable: isRetryableError,
            run: async () => {
                const response = await openai.chat.completions.create(
                    buildChatCompletionParams({
                        model,
                        messages: [
                            { role: "system", content: systemContent },
                            { role: "user", content: prompt },
                        ],
                        temperature: 0.3,
                        maxTokens: 2000,
                    }),
                );
                await recordChatCompletionUsage(
                    {
                        recordingId,
                        ownerUserId: ctx.ownerUserId,
                        payerUserId: ctx.actorUserId,
                        operation: "topics",
                        provider: credentials.provider,
                        model,
                        baseUrl: credentials.baseUrl,
                        credentialId: credentials.id,
                    },
                    response,
                );
                return response.choices[0]?.message?.content?.trim() || "";
            },
            onRetry: ({ attempt, delayMs }) => {
                console.warn(
                    `[topics] window ${index + 1} attempt ${attempt} failed, retrying in ${delayMs}ms`,
                );
            },
        });

        const candidates = parseTopicsReply(reply);
        if (!candidates) {
            console.warn(
                `[topics] window ${index + 1} of ${windows.length} returned no topic list`,
            );
        }
        topicsPerWindow.push(
            anchorTopics(candidates ?? [], window.marks, endMs),
        );
    }

    const topics = finishTopics(
        joinWindowTopics(windows, topicsPerWindow),
        endMs,
    );
    if (topics.length === 0) {
        throw new AppError(
            ErrorCode.AI_PROVIDER_API_ERROR,
            "The model's reply held no usable topics",
            502,
        );
    }

    const stored: StoredTopics = {
        topics,
        provider: credentials.provider,
        model,
        templateId,
        generatedAt: new Date().toISOString(),
    };
    // Written only if the transcript is still the one the topics were read
    // from. Every write of a transcript re-encrypts its text, so an unchanged
    // ciphertext means an unchanged transcript; a re-transcription that
    // landed meanwhile has already cleared topics, and must keep them clear.
    // Under the recording lock sharing takes, so a recording shared while
    // the model ran keeps what it was shared with.
    const orgUserId = await sharingOrgUserId();
    const written = await db.transaction(async (tx) => {
        await tx
            .select({ id: recordings.id })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            )
            .for("update");
        const shared = await contentWriterRefusal(tx, {
            recordingId,
            ownerUserId: userId,
            actorUserId: ctx.actorUserId,
            orgUserId,
        });
        if (shared) throw writerRefusalError(shared);
        return tx
            .update(transcriptions)
            .set({
                topics: encryptJsonField(stored),
                topicsInputFingerprint: input.fingerprint,
            })
            .where(
                and(
                    eq(transcriptions.id, transcript.id),
                    eq(transcriptions.text, transcript.text),
                ),
            )
            .returning({ id: transcriptions.id });
    });
    if (written.length === 0) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "The transcript changed while its topics were being detected. Detect them again.",
            409,
        );
    }

    await captureServerEvent({
        distinctId: ctx.actorUserId,
        event: "topics_generated",
        properties: {
            trigger: opts.trigger,
            provider: credentials.provider,
            topic_count: topics.length,
            windows: windows.length,
        },
    });

    return {
        topics,
        provider: credentials.provider,
        model,
        templateId,
        windows: windows.length,
    };
}
