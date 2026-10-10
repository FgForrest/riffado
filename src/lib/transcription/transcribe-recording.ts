import { and, eq, isNull, sql } from "drizzle-orm";
import { OpenAI } from "openai";
import { db } from "@/db";
import { audioItemColumns, recordingItemJoin } from "@/db/items";
import {
    aiEnhancements,
    apiCredentials,
    chatterItems,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import {
    getDefaultTranscriptionModel,
    getTranscriptionStyle,
} from "@/lib/ai/provider-presets";
import { recordAiUsage } from "@/lib/ai/usage-cost";
import { decrypt } from "@/lib/encryption";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { isHostedLockedOut } from "@/lib/entitlements";
import { env } from "@/lib/env";
import {
    exportRecordingSidecarsIfEnabled,
    removeRecordingSidecar,
} from "@/lib/export/document-sidecars";
import {
    isMynahConfigured,
    transcribeViaMynah,
} from "@/lib/hosted/transcription/mynah";
import { copyMatchingSpeakerAttributions } from "@/lib/knowledge/attribution";
import { speakerVersionOf } from "@/lib/knowledge/speaker-label-rules";
import { storedSpeakerVersion } from "@/lib/knowledge/speaker-labels";
import {
    stampNewTranscriptAudioInTx,
    transcriptRewrittenInTx,
} from "@/lib/knowledge/transcript-rewrite";
import { holdForAutoLearn } from "@/lib/learn/auto-learn";
import { isOrgScopeEnabled } from "@/lib/org/config";
import {
    captureServerEvent,
    captureServerException,
} from "@/lib/posthog-server";
import { applyGeneratedTitle } from "@/lib/recordings/apply-generated-title";
import type { RecordingView } from "@/lib/sharing/access";
import { notifyIfShared } from "@/lib/sharing/notify";
import { resolveRunContext } from "@/lib/sharing/run-context";
import {
    contentWriterRefusal,
    contentWriterRefusalNow,
    sharingOrgUserId,
    type WriterRefusal,
} from "@/lib/sharing/writer";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { queueAutoSummary } from "@/lib/summary/auto-summary";
import { queueAutoTopics } from "@/lib/topics/topics-job";
import {
    type AlmanacTerm,
    almanacTermsFor,
} from "@/lib/transcription/almanac-terms";
import { buildAudioFile } from "@/lib/transcription/audio-file";
import { chatTranscribe } from "@/lib/transcription/chat-transcribe";
import { maybeCompressForWhisper } from "@/lib/transcription/compress-audio";
import {
    elevenLabsTakesKeyterms,
    elevenLabsTranscribe,
} from "@/lib/transcription/elevenlabs-transcribe";
import {
    buildTranscriptionParams,
    getResponseFormat,
    parseTranscriptionResponse,
} from "@/lib/transcription/format";
import { geminiTranscribe } from "@/lib/transcription/gemini-transcribe";
import { isRiffadoIncludedProviderId } from "@/lib/transcription/included-provider";
import { upsertTranscription } from "@/lib/transcription/persist";
import {
    speechmaticsTakesVocabulary,
    speechmaticsTranscribe,
} from "@/lib/transcription/speechmatics-transcribe";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { emitEvent } from "@/lib/webhooks/emit";

/**
 * Discriminator for typed error handling by durable transcription jobs and
 * direct internal callers.
 */
export type TranscribeErrorCode =
    | "RECORDING_NOT_FOUND"
    | "NO_TRANSCRIPTION_PROVIDER"
    | "RECORDING_DELETED"
    /** The retention sweep deleted the audio; nothing left to transcribe. */
    | "AUDIO_REAPED"
    | "HOSTED_LOCKED_OUT"
    | "MYNAH_BUDGET_EXHAUSTED"
    /**
     * Shared with the Organization: only the organization account changes
     * it, on the Organization view; its owner withdraws it first.
     */
    | "RECORDING_SHARED"
    | "TRANSCRIPTION_FAILED";

export interface StoreBrowserTranscriptionInput {
    userId: string;
    recordingId: string;
    text: string;
    detectedLanguage: string | null;
    model: string;
}

/**
 * Persist a transcription produced in the browser by Transformers.js.
 *
 * Mirrors the persistence half of `transcribeRecording` (tombstone check,
 * at-rest encryption, upsert, `transcription.completed` event) but skips
 * the server-side provider call. Auto-generated title and Plaud title
 * sync are intentionally NOT run from this path; browser-only users
 * typically have no AI provider configured and the title generation
 * would silently fail. If a browser-transcribing user later wants a
 * generated title they can trigger it once they configure an AI key.
 */
export async function storeBrowserTranscription(
    input: StoreBrowserTranscriptionInput,
): Promise<TranscribeResult> {
    const { userId, recordingId, text, detectedLanguage, model } = input;

    // Hosted lockout: a lapsed account is read-only, even for the
    // zero-cost browser path. No-op on self-host.
    if (await isHostedLockedOut(userId)) {
        await captureServerEvent({
            distinctId: userId,
            event: "hosted_locked_out_attempt",
            properties: { trigger: "browser" },
        });
        return {
            success: false,
            error: "Your hosted plan has lapsed. Subscribe to resume transcription.",
            errorCode: "HOSTED_LOCKED_OUT",
        };
    }

    const [recording] = await db
        .select({ id: recordings.id, deletedAt: recordings.deletedAt })
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
        return {
            success: false,
            error: "Recording not found",
            errorCode: "RECORDING_NOT_FOUND",
        };
    }

    const RECORDING_TOMBSTONED = Symbol("recording-tombstoned");
    const RECORDING_REFUSED = Symbol("recording-refused");
    let refused: WriterRefusal | null = null;
    // Before the transaction; see `sharingOrgUserId`.
    const orgUserId = await sharingOrgUserId();
    try {
        await db.transaction(async (tx) => {
            const [stillActive] = await tx
                .select({ deletedAt: recordings.deletedAt })
                .from(recordings)
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                    ),
                )
                .for("update")
                .limit(1);
            if (!stillActive || stillActive.deletedAt) {
                throw RECORDING_TOMBSTONED;
            }
            // Shared since the browser started: the Organization's now.
            refused = await contentWriterRefusal(tx, {
                recordingId,
                ownerUserId: userId,
                actorUserId: userId,
                orgUserId,
            });
            if (refused) throw RECORDING_REFUSED;

            const [existing] = await tx
                .select({
                    id: transcriptions.id,
                    text: transcriptions.text,
                    turns: transcriptions.turns,
                    source: transcriptions.source,
                    model: transcriptions.model,
                })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, recordingId),
                        eq(transcriptions.userId, userId),
                        eq(transcriptions.source, "riffado"),
                    ),
                )
                .limit(1);

            const encryptedText = encryptText(text);
            if (existing) {
                await tx
                    .update(transcriptions)
                    .set({
                        text: encryptedText,
                        detectedLanguage,
                        transcriptionType: "browser",
                        provider: "browser",
                        model,
                        source: "riffado",
                        turns: null,
                        topics: null,
                        topicsInputFingerprint: null,
                        producedByUserId: userId,
                        revision: sql`${transcriptions.revision} + 1`,
                    })
                    .where(
                        and(
                            eq(transcriptions.id, existing.id),
                            eq(transcriptions.userId, userId),
                        ),
                    );
                // What was said about the text just replaced.
                await transcriptRewrittenInTx(tx, {
                    userId,
                    transcriptionId: existing.id,
                    previous: storedSpeakerVersion(existing),
                    next: speakerVersionOf({
                        source: "riffado",
                        model,
                        text,
                        turns: null,
                    }),
                    audioMd5: null,
                });
            } else {
                await tx.insert(transcriptions).values({
                    recordingId,
                    userId,
                    text: encryptedText,
                    detectedLanguage,
                    transcriptionType: "browser",
                    provider: "browser",
                    model,
                    source: "riffado",
                    turns: null,
                    topics: null,
                    topicsInputFingerprint: null,
                    producedByUserId: userId,
                });
                // Which audio the browser fetched is not known here; it
                // has no turns, so no speaker rests on it.
                await stampNewTranscriptAudioInTx(tx, {
                    recordingId,
                    userId,
                    source: "riffado",
                    audioMd5: null,
                });
            }

            // The summary described the text replaced here; it goes in the
            // same transaction, under the same writer check.
            await tx
                .delete(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.itemId, recordingId),
                        eq(aiEnhancements.userId, userId),
                        eq(aiEnhancements.source, "riffado"),
                    ),
                );

            const now = new Date();
            await tx
                .update(recordings)
                .set({ updatedAt: now })
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                        isNull(recordings.deletedAt),
                    ),
                );
            await tx
                .update(chatterItems)
                .set({ contentReapedAt: null, updatedAt: now })
                .where(
                    and(
                        eq(chatterItems.id, recordingId),
                        eq(chatterItems.userId, userId),
                        isNull(chatterItems.deletedAt),
                    ),
                );
        });
    } catch (txError) {
        if (txError === RECORDING_REFUSED && refused) {
            return refusedResult(refused);
        }
        if (txError === RECORDING_TOMBSTONED) {
            return {
                success: false,
                error: "Recording was deleted before transcription finished",
                errorCode: "RECORDING_DELETED",
            };
        }
        throw txError;
    }

    await removeRecordingSidecar(userId, recordingId, "summary", "riffado");

    await exportRecordingSidecarsIfEnabled(
        userId,
        recordingId,
        "transcript",
        "riffado",
    );

    await emitEvent("transcription.completed", userId, recordingId);
    await captureServerEvent({
        distinctId: userId,
        event: "recording_transcribed",
        properties: { trigger: "browser", provider_type: "browser" },
    });
    return { success: true, text, detectedLanguage };
}

export interface TranscribeOptions {
    /** Use a specific provider (by id, user-scoped) instead of the user's default. */
    providerId?: string;
    /** Override the provider's default model for this single call. */
    model?: string;
    /** Transcript source whose confirmed speaker assignments may be carried forward. */
    attributionSource?: "riffado" | "plaud" | "mixed";
    /**
     * Re-run the provider call even when a transcript already exists.
     * Used by the manual "Re-transcribe" button so a user clicking it
     * with an override (or just wanting a fresh result) actually re-hits
     * the API and overwrites the stored transcript. The sync worker
     * leaves this `false` so duplicate post-sync auto-transcribes remain
     * idempotent.
     */
    force?: boolean;
    /** What triggered this call. Drives the `recording_transcribed` event's `trigger` property. */
    trigger?: "manual" | "sync" | "upload";
    /**
     * `org` transcribes the Organization view of a shared recording: the
     * caller is the actor whose provider runs, not the owner.
     */
    view?: RecordingView;
    /** The job this run finishes; cancelled meanwhile, it writes nothing. */
    jobId?: string;
}

export interface TranscribeResult {
    success: boolean;
    error?: string;
    errorCode?: TranscribeErrorCode;
    /** Present on success. Plaintext transcript. */
    text?: string;
    /** Present on success when the provider returned a language. */
    detectedLanguage?: string | null;
}

// Per-recording in-flight dedup within one process. Force and non-force
// are partitioned so Retry cannot inherit an auto-transcribe skip.
const inFlightTranscriptions = new Map<string, Promise<TranscribeResult>>();

export async function transcribeRecording(
    userId: string,
    recordingId: string,
    opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
    const key = `${userId}:${recordingId}:${opts.view ?? "private"}:${opts.force ? "force" : "auto"}`;
    const inFlight = inFlightTranscriptions.get(key);
    if (inFlight) {
        return inFlight;
    }
    const work = transcribeRecordingInner(userId, recordingId, opts);
    inFlightTranscriptions.set(key, work);
    try {
        return await work;
    } finally {
        inFlightTranscriptions.delete(key);
    }
}

async function transcribeRecordingInner(
    actorUserId: string,
    recordingId: string,
    opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
    const ctx = await resolveRunContext(
        actorUserId,
        recordingId,
        opts.view ?? "private",
    );
    if (!ctx) {
        return {
            success: false,
            error: "Recording not found",
            errorCode: "RECORDING_NOT_FOUND",
        };
    }
    const orgView = ctx.view === "org";
    // `userId` is the owner of the recording and of the rows this run reads
    // and writes, in either view: a shared recording is one recording.
    const userId = ctx.contentUserId;
    // A shared recording is the organization account's to transcribe, on
    // the Organization view, while the Organization accepts changes; its
    // owner withdraws it first. Checked where the run starts, whoever
    // queued it and whenever, so no provider is paid for a transcript that
    // would be refused. The write checks again, under the lock.
    if (orgView && !isOrgScopeEnabled()) {
        return recordingSharedResult(
            "The Organization is read-only on this instance",
        );
    }
    const refusal = await contentWriterRefusalNow({
        recordingId,
        ownerUserId: ctx.ownerUserId,
        actorUserId: ctx.actorUserId,
    });
    if (refusal) return refusedResult(refusal);
    try {
        // Hosted lockout: a lapsed account is read-only. No-op on
        // self-host (isHostedLockedOut always false there).
        if (await isHostedLockedOut(ctx.actorUserId)) {
            await captureServerEvent({
                distinctId: ctx.actorUserId,
                event: "hosted_locked_out_attempt",
                properties: { trigger: opts.trigger ?? "manual" },
            });
            return {
                success: false,
                error: "Your hosted plan has lapsed. Subscribe to resume transcription.",
                errorCode: "HOSTED_LOCKED_OUT",
            };
        }

        const [recording] = await db
            .select(audioItemColumns)
            .from(recordings)
            .innerJoin(chatterItems, recordingItemJoin)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, ctx.ownerUserId),
                    // Skip tombstoned recordings. Without this filter the
                    // post-sync auto-transcribe path would happily upload the
                    // audio for a recording the user just deleted, recreate
                    // its transcription row, and (if syncTitleToPlaud is on)
                    // even push a generated title back to Plaud. See PR #72.
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1);

        if (!recording) {
            return {
                success: false,
                error: "Recording not found",
                errorCode: "RECORDING_NOT_FOUND",
            };
        }

        // A retention sweep deleted the audio. There is nothing to send to
        // a provider, so fail here with a message that explains the state
        // instead of letting `downloadFile` throw a storage error that
        // reads like a bug -- and, on a paid provider, without having
        // first spent a request finding that out.
        if (recording.audioReapedAt) {
            return {
                success: false,
                error: "Audio was removed by your retention policy, so this recording can no longer be transcribed",
                errorCode: "AUDIO_REAPED",
            };
        }

        const [existingTranscription] = await db
            .select()
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, userId),
                    // Only the user's own ('riffado') transcript gates the
                    // idempotent short-circuit and forced re-run. A
                    // Plaud-imported transcript ('plaud') must NOT suppress the
                    // user's own run, and the user's run must NOT overwrite the
                    // Plaud row — the two coexist. See #204.
                    eq(transcriptions.source, "riffado"),
                ),
            )
            .limit(1);

        if (existingTranscription?.text && !opts.force) {
            // Idempotent short-circuit: a prior run already produced a
            // transcript and the caller hasn't asked for a forced re-run.
            // The sync worker relies on this so duplicate post-sync
            // auto-transcribes are no-ops. The manual "Re-transcribe"
            // route passes `force: true` to bypass it (so provider/model
            // overrides actually take effect).
            return {
                success: true,
                text: decryptText(existingTranscription.text),
                detectedLanguage: existingTranscription.detectedLanguage,
            };
        }

        const [legacyDefaultCredentials] = opts.providerId
            ? []
            : await db
                  .select()
                  .from(apiCredentials)
                  .where(
                      and(
                          eq(apiCredentials.userId, ctx.actorUserId),
                          eq(apiCredentials.isDefaultTranscription, true),
                      ),
                  )
                  .limit(1);

        // The engine (provider pointer) is the actor's, because the keys are.
        // What the output should look like (language) follows the view.
        const [settings] = await db
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, ctx.actorUserId))
            .limit(1);
        const [contentSettings] =
            ctx.settingsUserId === ctx.actorUserId
                ? [settings]
                : await db
                      .select()
                      .from(userSettings)
                      .where(eq(userSettings.userId, ctx.settingsUserId))
                      .limit(1);

        const defaultLanguage =
            contentSettings?.defaultTranscriptionLanguage || undefined;
        const quality = settings?.transcriptionQuality || "balanced";
        // Title, Plaud and automation side effects act on the owner's
        // recording; a run on the Organization view never triggers them.
        const autoGenerateTitle =
            !orgView && (settings?.autoGenerateTitle ?? true);
        const syncTitleToPlaud = settings?.syncTitleToPlaud ?? false;
        const autoSummarize = !orgView && (settings?.autoSummarize ?? false);
        const autoSummarizePreset = settings?.autoSummarizePreset ?? null;
        const pointer = settings?.defaultTranscriptionProviderId ?? null;
        const requested = opts.providerId || pointer || null;
        const useManaged = isRiffadoIncludedProviderId(requested);

        void quality;

        let credentials: typeof apiCredentials.$inferSelect | undefined;
        if (!useManaged && requested) {
            [credentials] = await db
                .select()
                .from(apiCredentials)
                .where(
                    and(
                        eq(apiCredentials.id, requested),
                        eq(apiCredentials.userId, ctx.actorUserId),
                    ),
                )
                .limit(1);
        } else if (!useManaged) {
            credentials = legacyDefaultCredentials;
        }

        const runManagedTranscription = async () => {
            const input = {
                userId: ctx.actorUserId,
                storagePath: recording.storagePath,
                durationMs: recording.duration,
                language: defaultLanguage,
                filename: decryptText(recording.title),
            };
            const result = await transcribeViaMynah(input);
            await recordAiUsage(
                {
                    recordingId,
                    ownerUserId: ctx.ownerUserId,
                    payerUserId: ctx.actorUserId,
                    operation: "transcription",
                    provider: "Mynah",
                    model: "parakeet",
                },
                { reportedCostUsd: 0, audioSeconds: recording.duration / 1000 },
            );
            return {
                text: result.text,
                detectedLanguage: result.detectedLanguage,
                provider: "mynah",
                model: "parakeet",
            };
        };

        // The Almanac's names, for the providers that can be told what to
        // expect. A failure to read them costs accuracy, not the run.
        const almanacTerms = async (): Promise<AlmanacTerm[]> => {
            try {
                return await almanacTermsFor({
                    ownerUserId: ctx.ownerUserId,
                    shared: orgView,
                    language: defaultLanguage ?? null,
                });
            } catch (error) {
                console.error(
                    "[transcription] Almanac terms unavailable:",
                    error,
                );
                return [];
            }
        };

        let transcriptionText: string;
        let detectedLanguage: string | null;
        let persistProvider: string;
        let persistModel: string;
        // Only providers that report timings set this (the diarizing ones, and
        // Whisper's verbose format as speakerless paragraphs); the rest leave
        // it undefined and `upsertTranscription` clears any turns a previous
        // run stored.
        let turns: TranscriptTurn[] | undefined;

        if (useManaged) {
            if (!isMynahConfigured()) {
                return {
                    success: false,
                    error: "No transcription API configured",
                    errorCode: "NO_TRANSCRIPTION_PROVIDER",
                };
            }
            const result = await runManagedTranscription();
            transcriptionText = result.text;
            detectedLanguage = result.detectedLanguage;
            persistProvider = result.provider;
            persistModel = result.model;
        } else if (credentials) {
            const apiKey = decrypt(credentials.apiKey);

            const storage = await createUserStorageProvider(ctx.ownerUserId);
            const audioBuffer = await storage.downloadFile(
                recording.storagePath,
            );

            // `recording.title` is encrypted at rest; decrypt before
            // passing to the transcription provider as a filename hint.
            const decryptedFilename = decryptText(recording.title);
            const { file: audioFile, contentType } = buildAudioFile(
                audioBuffer,
                recording.storagePath,
                decryptedFilename,
            );

            const model =
                opts.model ||
                credentials.defaultModel ||
                getDefaultTranscriptionModel(credentials.provider) ||
                "whisper-1";
            persistProvider = credentials.provider;
            persistModel = model;

            // Route based on the provider's transcription style:
            // - "gemini": Google Gemini native generateContent API (inlineData)
            // - "elevenlabs": ElevenLabs Scribe /v1/speech-to-text multipart
            // - "speechmatics": Speechmatics Batch jobs API (submit, poll,
            //   download), hidden behind one awaited adapter call
            // - "chat": OpenAI-compatible chat completions with input_audio
            //   (OpenRouter today; #122 -- /v1/audio/transcriptions 404s there)
            // - "whisper": OpenAI-compatible /v1/audio/transcriptions
            const transcriptionStyle = getTranscriptionStyle(
                credentials.provider,
            );

            if (transcriptionStyle === "gemini") {
                const result = await geminiTranscribe({
                    apiKey,
                    model,
                    audioBuffer,
                    contentType,
                    language: defaultLanguage,
                });
                await recordAiUsage(
                    {
                        recordingId,
                        ownerUserId: ctx.ownerUserId,
                        payerUserId: ctx.actorUserId,
                        operation: "transcription",
                        provider: credentials.provider,
                        model,
                        baseUrl: credentials.baseUrl,
                        credentialId: credentials.id,
                    },
                    {
                        inputTokens: result.inputTokens,
                        outputTokens: result.outputTokens,
                    },
                );
                transcriptionText = result.text;
                detectedLanguage = result.detectedLanguage;
            } else if (transcriptionStyle === "elevenlabs") {
                // Scribe accepts multi-gigabyte uploads, so the Whisper
                // 25 MiB re-encode is deliberately skipped here.
                const keyterms = elevenLabsTakesKeyterms(model)
                    ? (await almanacTerms()).map((term) => term.text)
                    : [];
                const result = await elevenLabsTranscribe({
                    apiKey,
                    model,
                    file: audioFile,
                    language: defaultLanguage,
                    baseUrl: credentials.baseUrl,
                    keyterms,
                });
                await recordAiUsage(
                    {
                        recordingId,
                        ownerUserId: ctx.ownerUserId,
                        payerUserId: ctx.actorUserId,
                        operation: "transcription",
                        provider: credentials.provider,
                        model,
                        baseUrl: credentials.baseUrl,
                        credentialId: credentials.id,
                    },
                    {
                        audioSeconds: recording.duration / 1000,
                        keytermCount: keyterms.length,
                    },
                );
                transcriptionText = result.text;
                detectedLanguage = result.detectedLanguage;
                turns = result.turns;
            } else if (transcriptionStyle === "speechmatics") {
                // Batch accepts hours-long uploads, so the Whisper 25 MiB
                // re-encode is skipped here the same way it is for Scribe.
                const result = await speechmaticsTranscribe({
                    apiKey,
                    model,
                    file: audioFile,
                    language: defaultLanguage,
                    baseUrl: credentials.baseUrl,
                    vocabulary: speechmaticsTakesVocabulary(model)
                        ? await almanacTerms()
                        : [],
                });
                await recordAiUsage(
                    {
                        recordingId,
                        ownerUserId: ctx.ownerUserId,
                        payerUserId: ctx.actorUserId,
                        operation: "transcription",
                        provider: credentials.provider,
                        model,
                        baseUrl: credentials.baseUrl,
                        credentialId: credentials.id,
                    },
                    { audioSeconds: recording.duration / 1000 },
                );
                transcriptionText = result.text;
                detectedLanguage = result.detectedLanguage;
                turns = result.turns;
            } else {
                const openai = new OpenAI({
                    apiKey,
                    baseURL: credentials.baseUrl || undefined,
                    timeout: env.WHISPER_REQUEST_TIMEOUT_MS,
                });

                if (transcriptionStyle === "chat") {
                    const result = await chatTranscribe({
                        client: openai,
                        model,
                        audioBuffer,
                        contentType,
                        language: defaultLanguage,
                    });
                    await recordAiUsage(
                        {
                            recordingId,
                            ownerUserId: ctx.ownerUserId,
                            payerUserId: ctx.actorUserId,
                            operation: "transcription",
                            provider: credentials.provider,
                            model,
                            baseUrl: credentials.baseUrl,
                            credentialId: credentials.id,
                        },
                        {
                            inputTokens: result.inputTokens,
                            outputTokens: result.outputTokens,
                            reportedCostUsd: result.reportedCostUsd,
                        },
                    );
                    transcriptionText = result.text;
                    detectedLanguage = result.detectedLanguage;
                } else {
                    const responseFormat = getResponseFormat(model);

                    // OpenAI's /v1/audio/transcriptions endpoint has a hard
                    // 25 MiB per-request limit. For meeting-length recordings
                    // that limit is the common case, not the edge case -- fall
                    // back to a mono Opus re-encode so 3 h+ uploads don't get
                    // rejected with a 413.
                    const compressed = await maybeCompressForWhisper(
                        audioBuffer,
                        contentType,
                    );
                    const fileToSend = compressed.compressed
                        ? buildAudioFile(
                              compressed.buffer,
                              recording.storagePath,
                              decryptedFilename,
                          ).file
                        : audioFile;

                    // Whisper-1 runs ~0.1-0.3x realtime, so a 3 h recording
                    // can keep the request open 20-40 min. The SDK default
                    // (10 min) times out long before that; override
                    // per-request so other OpenAI calls keep the default.
                    const transcription =
                        await openai.audio.transcriptions.create(
                            buildTranscriptionParams({
                                file: fileToSend,
                                model,
                                responseFormat,
                                language: defaultLanguage,
                            }),
                            { timeout: env.WHISPER_REQUEST_TIMEOUT_MS },
                        );
                    const measured =
                        typeof transcription === "string"
                            ? null
                            : (
                                  transcription as {
                                      usage?: {
                                          input_tokens?: number;
                                          output_tokens?: number;
                                          seconds?: number;
                                      };
                                  }
                              ).usage;
                    await recordAiUsage(
                        {
                            recordingId,
                            ownerUserId: ctx.ownerUserId,
                            payerUserId: ctx.actorUserId,
                            operation: "transcription",
                            provider: credentials.provider,
                            model,
                            baseUrl: credentials.baseUrl,
                            credentialId: credentials.id,
                        },
                        {
                            inputTokens: measured?.input_tokens,
                            outputTokens: measured?.output_tokens,
                            audioSeconds:
                                measured?.seconds ?? recording.duration / 1000,
                        },
                    );
                    const parsed = parseTranscriptionResponse(
                        transcription,
                        responseFormat,
                    );
                    transcriptionText = parsed.text;
                    detectedLanguage = parsed.detectedLanguage;
                    turns = parsed.turns;
                }
            }
        } else {
            if (requested || !isMynahConfigured()) {
                return {
                    success: false,
                    error: "No transcription API configured",
                    errorCode: "NO_TRANSCRIPTION_PROVIDER",
                };
            }
            const result = await runManagedTranscription();
            transcriptionText = result.text;
            detectedLanguage = result.detectedLanguage;
            persistProvider = result.provider;
            persistModel = result.model;
        }

        // Persist the user's own ('riffado') transcript via the shared,
        // tombstone-aware, source-scoped upsert. The persisted model is the
        // *actual* model used (may differ from the provider default when the
        // manual route supplied an override).
        const { committed, reason } = await upsertTranscription({
            userId,
            recordingId,
            text: transcriptionText,
            detectedLanguage,
            source: "riffado",
            provider: persistProvider,
            model: persistModel,
            turns,
            allowReaped: (opts.trigger ?? "manual") === "manual",
            actorUserId: ctx.actorUserId,
            // The summary describes the text a forced re-run replaces.
            dropSummaryOnReplace: opts.force ? "riffado" : undefined,
            jobId: opts.jobId,
            // The audio this run downloaded, not whatever a sync put there
            // meanwhile.
            audioMd5: recording.fileMd5,
        });

        if (!committed && reason) return refusedResult(reason);
        if (!committed) {
            return {
                success: false,
                error: "Recording was deleted before transcription finished",
                errorCode: "RECORDING_DELETED",
            };
        }

        // The upsert moved the speaker names onto the new labels itself.
        const nextSpeakerCount = speakerVersionOf({
            source: "riffado",
            model: persistModel,
            text: transcriptionText,
            turns,
        }).labels.length;
        if (
            !existingTranscription &&
            opts.force &&
            opts.attributionSource &&
            opts.attributionSource !== "riffado" &&
            nextSpeakerCount > 0
        ) {
            await copyMatchingSpeakerAttributions({
                userId,
                recordingId,
                sourceSource: opts.attributionSource,
                targetSource: "riffado",
                // Shared or withdrawn since the transcript was written:
                // someone else's to change now.
                writer: {
                    actorUserId: ctx.actorUserId,
                    orgUserId: await sharingOrgUserId(),
                },
            });
        }

        await exportRecordingSidecarsIfEnabled(
            userId,
            recordingId,
            "transcript",
            "riffado",
        );

        // The previous transcript was overwritten, so its summary, which
        // described the old text, went with it in the write above: readers
        // never see "fresh transcript + old summary". If auto-summarize is
        // on, a fresh summary is generated below; otherwise the recording
        // shows no summary until someone clicks "Generate summary". Its
        // exported file goes here.
        if (existingTranscription?.text && opts.force) {
            await removeRecordingSidecar(
                userId,
                recordingId,
                "summary",
                "riffado",
            );
        }

        // Automatic Learn holds the title, summary and topics back until
        // its review is done (72 h at most), so they are made from the
        // transcript as corrected; `transcription.completed` then fires
        // without the title, which follows as `recording.updated`.
        const heldForLearn =
            !orgView &&
            (await holdForAutoLearn({
                userId,
                recordingId,
                timed: Boolean(turns?.length),
            }));

        if (!heldForLearn && autoGenerateTitle && transcriptionText.trim()) {
            try {
                await applyGeneratedTitle({
                    userId,
                    recordingId,
                    text: transcriptionText,
                    plaudFileId: recording.plaudFileId,
                    syncTitleToPlaud,
                });
            } catch (error) {
                console.error("Failed to generate title:", error);
            }
        }

        await emitEvent("transcription.completed", userId, recordingId);
        await notifyIfShared(recordingId);
        await captureServerEvent({
            distinctId: ctx.actorUserId,
            event: "recording_transcribed",
            properties: {
                trigger: opts.trigger ?? "manual",
                provider_type:
                    persistProvider === "mynah" ? "mynah" : "own_key",
                detected_language: detectedLanguage ?? null,
            },
        });

        // Topics need the timings only some providers report. Queued like the
        // summary, and like it not after a run on the Organization view,
        // where the organization account detects them by hand.
        if (!heldForLearn && !orgView && turns?.length) {
            await queueAutoTopics(userId, recordingId, "riffado");
        }

        if (!heldForLearn && autoSummarize) {
            await queueAutoSummary(userId, recordingId, autoSummarizePreset);
        }

        return {
            success: true,
            text: transcriptionText,
            detectedLanguage,
        };
    } catch (error) {
        console.error("Error transcribing recording:", error);
        if (isMynahBudgetExhausted(error)) {
            if (!orgView) {
                await emitEvent("transcription.failed", userId, recordingId, {
                    error: "included_transcription_budget_exhausted",
                });
            }
            await captureServerEvent({
                distinctId: ctx.actorUserId,
                event: "mynah_budget_exhausted",
                properties: { trigger: opts.trigger ?? "manual" },
            });
            return {
                success: false,
                error: "You've used all of your included Mynah transcription for this cycle. It resets next cycle, or add your own AI provider to keep transcribing.",
                errorCode: "MYNAH_BUDGET_EXHAUSTED",
            };
        }
        captureServerException(error, {
            source: "transcription",
            distinctId: ctx.actorUserId,
            trigger: opts.trigger ?? "manual",
        });
        if (!orgView) {
            await emitEvent("transcription.failed", userId, recordingId, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return {
            success: false,
            error:
                error instanceof Error ? error.message : "Transcription failed",
            errorCode: "TRANSCRIPTION_FAILED",
        };
    }
}

function recordingSharedResult(
    error = "This recording is shared with the Organization; only its account transcribes it",
): TranscribeResult {
    return { success: false, error, errorCode: "RECORDING_SHARED" };
}

function refusedResult(refusal: WriterRefusal | "cancelled"): TranscribeResult {
    if (refusal === "shared") return recordingSharedResult();
    return {
        success: false,
        error:
            refusal === "cancelled"
                ? "The run was cancelled before it finished"
                : "Recording not found",
        errorCode: "RECORDING_NOT_FOUND",
    };
}

function isMynahBudgetExhausted(error: unknown): boolean {
    return error instanceof Error && error.name === "MynahBudgetExhaustedError";
}
