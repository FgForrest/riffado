import { and, eq, isNull } from "drizzle-orm";
import { OpenAI } from "openai";
import { db } from "@/db";
import {
    aiEnhancements,
    apiCredentials,
    plaudConnections,
    recordings,
    transcriptions,
    transcriptSpeakers,
    userSettings,
} from "@/db/schema";
import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import {
    getDefaultTranscriptionModel,
    getTranscriptionStyle,
} from "@/lib/ai/provider-presets";
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
import { createPlaudClient } from "@/lib/plaud/client-factory";
import {
    captureServerEvent,
    captureServerException,
} from "@/lib/posthog-server";
import { consumeRateLimitBucket } from "@/lib/rate-limit";
import type { RecordingView } from "@/lib/sharing/access";
import { notifyIfShared, orgContentChanged } from "@/lib/sharing/notify";
import {
    applyCarriedSpeakerNames,
    captureSpeakerNames,
} from "@/lib/sharing/org-transcript";
import { resolveRunContext } from "@/lib/sharing/run-context";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { enqueueSummaryJob } from "@/lib/summary/summary-job";
import { buildAudioFile } from "@/lib/transcription/audio-file";
import { chatTranscribe } from "@/lib/transcription/chat-transcribe";
import { maybeCompressForWhisper } from "@/lib/transcription/compress-audio";
import {
    parseSpeakerTurns,
    speakerOrder,
} from "@/lib/transcription/diarization";
import { elevenLabsTranscribe } from "@/lib/transcription/elevenlabs-transcribe";
import {
    buildTranscriptionParams,
    getResponseFormat,
    parseTranscriptionResponse,
} from "@/lib/transcription/format";
import { geminiTranscribe } from "@/lib/transcription/gemini-transcribe";
import { isRiffadoIncludedProviderId } from "@/lib/transcription/included-provider";
import { upsertTranscription } from "@/lib/transcription/persist";
import { speechmaticsTranscribe } from "@/lib/transcription/speechmatics-transcribe";
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

            const [existing] = await tx
                .select({ id: transcriptions.id })
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
                    })
                    .where(
                        and(
                            eq(transcriptions.id, existing.id),
                            eq(transcriptions.userId, userId),
                        ),
                    );
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
                });
            }

            await tx
                .update(recordings)
                .set({ transcriptReapedAt: null, updatedAt: new Date() })
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                        isNull(recordings.deletedAt),
                    ),
                );
        });
    } catch (txError) {
        if (txError === RECORDING_TOMBSTONED) {
            return {
                success: false,
                error: "Recording was deleted before transcription finished",
                errorCode: "RECORDING_DELETED",
            };
        }
        throw txError;
    }

    await db
        .delete(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.recordingId, recordingId),
                eq(aiEnhancements.userId, userId),
                eq(aiEnhancements.source, "riffado"),
            ),
        );
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

function recognizedSpeakerCount(text: string): number {
    const parsed = parseSpeakerTurns(text);
    return parsed ? speakerOrder(parsed).length : 0;
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
    // `userId` is the owner of the rows this run reads and writes; on the
    // private view that is also the actor and the recording's owner.
    const userId = ctx.contentUserId;
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
            .select()
            .from(recordings)
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
                filename: decryptText(recording.filename),
            };
            const result = await transcribeViaMynah(input);
            return {
                text: result.text,
                detectedLanguage: result.detectedLanguage,
                provider: "mynah",
                model: "parakeet",
            };
        };

        let transcriptionText: string;
        let detectedLanguage: string | null;
        let persistProvider: string;
        let persistModel: string;
        // Only the diarizing providers set this; the rest leave it undefined
        // and `upsertTranscription` clears any turns a previous run stored.
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

            // `recording.filename` is encrypted at rest; decrypt before
            // passing to the transcription provider as a filename hint.
            const decryptedFilename = decryptText(recording.filename);
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
                transcriptionText = result.text;
                detectedLanguage = result.detectedLanguage;
            } else if (transcriptionStyle === "elevenlabs") {
                // Scribe accepts multi-gigabyte uploads, so the Whisper
                // 25 MiB re-encode is deliberately skipped here.
                const result = await elevenLabsTranscribe({
                    apiKey,
                    model,
                    file: audioFile,
                    language: defaultLanguage,
                    baseUrl: credentials.baseUrl,
                });
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
                });
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

        // The names the Organization view showed, read before this run
        // replaces the transcript they were confirmed against.
        const carriedNames = orgView
            ? await captureSpeakerNames(recordingId, ctx)
            : null;

        // Persist the user's own ('riffado') transcript via the shared,
        // tombstone-aware, source-scoped upsert. The persisted model is the
        // *actual* model used (may differ from the provider default when the
        // manual route supplied an override).
        const { committed } = await upsertTranscription({
            userId,
            recordingId,
            text: transcriptionText,
            detectedLanguage,
            source: "riffado",
            provider: persistProvider,
            model: persistModel,
            turns,
            allowReaped: (opts.trigger ?? "manual") === "manual",
            recordingOwnerId: ctx.ownerUserId,
            producedByUserId: ctx.actorUserId,
        });

        if (!committed) {
            return {
                success: false,
                error: "Recording was deleted before transcription finished",
                errorCode: "RECORDING_DELETED",
            };
        }

        const previousSpeakerCount = existingTranscription?.text
            ? recognizedSpeakerCount(decryptText(existingTranscription.text))
            : 0;
        const nextSpeakerCount = recognizedSpeakerCount(transcriptionText);
        const canPreserveSpeakerAttributions =
            previousSpeakerCount > 0 &&
            previousSpeakerCount === nextSpeakerCount;
        if (orgView) {
            const [orgTranscript] = await db
                .select({ id: transcriptions.id })
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, recordingId),
                        eq(transcriptions.userId, userId),
                        eq(transcriptions.source, "riffado"),
                    ),
                )
                .limit(1);
            if (orgTranscript) {
                await applyCarriedSpeakerNames(
                    carriedNames,
                    orgTranscript.id,
                    userId,
                );
            }
        } else if (
            existingTranscription?.text &&
            opts.force &&
            !canPreserveSpeakerAttributions
        ) {
            await db
                .delete(transcriptSpeakers)
                .where(
                    and(
                        eq(transcriptSpeakers.userId, userId),
                        eq(
                            transcriptSpeakers.transcriptionId,
                            existingTranscription.id,
                        ),
                    ),
                );
        }

        if (
            !orgView &&
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
                targetText: transcriptionText,
            });
        }

        if (!orgView) {
            await exportRecordingSidecarsIfEnabled(
                userId,
                recordingId,
                "transcript",
                "riffado",
            );
        }

        // The previous transcript is being overwritten, so any existing
        // summary now references stale source text. Drop it so readers never
        // see "fresh transcript + old summary". If auto-summarize is on, a
        // fresh summary is generated below; otherwise the recording shows no
        // summary until the user clicks "Generate summary" manually. An
        // Organization summary may also predate its first own transcript,
        // having been made from the owner's, so it goes either way.
        if (orgView || (existingTranscription?.text && opts.force)) {
            await db
                .delete(aiEnhancements)
                .where(
                    and(
                        eq(aiEnhancements.recordingId, recordingId),
                        eq(aiEnhancements.userId, userId),
                        eq(aiEnhancements.source, "riffado"),
                    ),
                );
            if (!orgView) {
                await removeRecordingSidecar(
                    userId,
                    recordingId,
                    "summary",
                    "riffado",
                );
            }
        }

        if (autoGenerateTitle && transcriptionText.trim()) {
            try {
                const generatedTitle = await generateTitleFromTranscription(
                    userId,
                    transcriptionText,
                );

                if (generatedTitle) {
                    // Encrypt the generated title before storing it as the
                    // recording's filename. The plaintext is still available
                    // below for the optional sync-to-Plaud push.
                    await db
                        .update(recordings)
                        .set({
                            filename: encryptText(generatedTitle),
                            updatedAt: new Date(),
                        })
                        .where(
                            and(
                                eq(recordings.id, recordingId),
                                eq(recordings.userId, userId),
                                isNull(recordings.deletedAt),
                            ),
                        );

                    if (syncTitleToPlaud) {
                        try {
                            const [connection] = await db
                                .select()
                                .from(plaudConnections)
                                .where(eq(plaudConnections.userId, userId))
                                .limit(1);

                            if (connection) {
                                const plaudClient = await createPlaudClient(
                                    connection.bearerToken,
                                    connection.apiBase,
                                    connection.workspaceId,
                                );
                                await plaudClient.updateFilename(
                                    recording.plaudFileId,
                                    generatedTitle,
                                );
                                // Backfill workspaceId if newly resolved.
                                // Always scope user-owned UPDATEs by userId
                                // even when filtering by id (per AGENTS.md).
                                const resolved = plaudClient.workspaceId;
                                if (
                                    resolved &&
                                    resolved !== connection.workspaceId
                                ) {
                                    await db
                                        .update(plaudConnections)
                                        .set({ workspaceId: resolved })
                                        .where(
                                            and(
                                                eq(
                                                    plaudConnections.id,
                                                    connection.id,
                                                ),
                                                eq(
                                                    plaudConnections.userId,
                                                    userId,
                                                ),
                                            ),
                                        );
                                }
                            }
                        } catch (error) {
                            console.error(
                                "Failed to sync title to Plaud:",
                                error,
                            );
                        }
                    }
                }
            } catch (error) {
                console.error("Failed to generate title:", error);
            }
        }

        if (orgView) {
            await orgContentChanged(recordingId);
        } else {
            await emitEvent("transcription.completed", userId, recordingId);
            await notifyIfShared(recordingId);
        }
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

        if (autoSummarize) {
            // Per-user hourly cap on auto-summary calls. Cheap defense
            // against runaway provider cost if a sync replays N
            // recordings or the user toggles auto-summarize on with an
            // expensive model. The manual "Generate summary" button is
            // not throttled -- the user is in the loop there.
            const rateLimit = await consumeRateLimitBucket(
                `auto-summary:user:${userId}`,
                {
                    limit: env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR,
                    windowMs: 60 * 60 * 1000,
                },
            );

            if (!rateLimit.allowed) {
                console.warn(
                    `Auto-summary rate limit hit for user ${userId} (recording ${recordingId})`,
                );
                await emitEvent("summary.failed", userId, recordingId, {
                    error: `Auto-summary rate limit exceeded (${env.AUTO_SUMMARY_RATE_LIMIT_PER_HOUR}/hour). Manual summary still works.`,
                });
            } else {
                // Queued rather than run inline. This is the unattended path
                // -- a sync can trigger a dozen of these with nobody
                // watching -- and inline it inherited the lifetime of
                // whatever process happened to be transcribing: a container
                // upgrade partway through left a recording that simply never
                // got a summary, with nothing to say why or to try again.
                //
                // `summary.completed` and `summary.failed` now come from the
                // job handler, which keeps their meaning intact: the event
                // still fires after the summary is written and readable,
                // just from the worker rather than from here. What changes is
                // that this function no longer waits for it.
                try {
                    await enqueueSummaryJob({
                        userId,
                        recordingId,
                        presetId: autoSummarizePreset ?? undefined,
                        trigger: "auto",
                    });
                } catch (error) {
                    // Only a failure to QUEUE reaches here, which means the
                    // database refused the insert -- the summary itself has
                    // not been attempted yet. Never roll back the transcript
                    // over it: the user wants the transcript regardless.
                    console.error(
                        `Could not queue auto-summary for recording ${recordingId}:`,
                        error,
                    );
                    await emitEvent("summary.failed", userId, recordingId, {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                }
            }
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

function isMynahBudgetExhausted(error: unknown): boolean {
    return error instanceof Error && error.name === "MynahBudgetExhaustedError";
}
