import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { audioItemColumns, recordingItemJoin } from "@/db/items";
import {
    chatterItems,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { CONTENT_IS_DATA_DIRECTIVE } from "@/lib/ai/content-directive";
import { resolveTemplate } from "@/lib/ai/prompt-templates";
import {
    getAiOutputLanguageDirective,
    localizedSummaryPrompt,
    normalizeSummaryPromptConfig,
    resolveAiOutputLanguage,
    SUMMARY_MARKDOWN_DIRECTIVE,
    SUMMARY_SPEAKER_DIRECTIVE,
    SUMMARY_TEMPLATE_KIND,
} from "@/lib/ai/summary-presets";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { exportRecordingSidecarsIfEnabled } from "@/lib/export/document-sidecars";
import { modelInput } from "@/lib/learn/llm-input";
import { captureServerEvent } from "@/lib/posthog-server";
import type { RecordingView } from "@/lib/sharing/access";
import { notifyIfShared } from "@/lib/sharing/notify";
import { resolveRunContext } from "@/lib/sharing/run-context";
import {
    contentWriterRefusalNow,
    writerRefusalError,
} from "@/lib/sharing/writer";
import { taskViewerById } from "@/lib/tasks/access";
import {
    SUMMARY_TASKS_DIRECTIVE,
    SUMMARY_TASKS_MERGE_DIRECTIVE,
} from "@/lib/tasks/directive";
import {
    loadTasksPromptContext,
    resolveTaskProposals,
} from "@/lib/tasks/proposals";
import { upsertEnhancement } from "@/lib/transcription/persist";
import type { MultiPassProgress } from "./multi-pass";
import { runSummary, summaryModelFor } from "./summary-model";

export interface GenerateSummaryOptions {
    /**
     * Preset id to use for this run. Overrides the user's default
     * `summaryPrompt.selectedPrompt`. When omitted, falls back to the
     * user's saved preset (which itself falls back to "general").
     */
    presetId?: string;
    /** Analytics `trigger` property on the `summary_generated` event. */
    trigger?: "manual" | "auto";
    /**
     * Called as multi-pass work advances. Never called on the single-pass
     * path, which has nothing to report between "started" and "finished".
     *
     * Exists so a caller that can stream -- the route, and later the job
     * worker -- can show which pass is in flight. `generateSummaryForRecording`
     * itself stays a plain awaitable; progress is a side channel, never a
     * requirement.
     */
    onProgress?: (progress: MultiPassProgress) => void;
    /**
     * `org` summarizes the Organization view of a shared recording: the
     * caller is the actor whose provider runs, with the organization's
     * prompts and language.
     */
    view?: RecordingView;
    /** The job this run finishes; cancelled meanwhile, it writes nothing. */
    jobId?: string;
}

export interface GenerateSummaryResult {
    /** The recording's owner, whose summary this is in either view. */
    ownerUserId: string;
    summary: string;
    keyPoints: string[];
    actionItems: string[];
    provider: string;
    model: string;
    /** Prompt id actually used. Can differ from the requested preset. */
    promptId: string;
    /**
     * True when the requested/saved prompt id couldn't be resolved (e.g. a
     * custom prompt deleted from another tab) and generation fell back to
     * the default prompt instead.
     */
    promptFallback: boolean;
    /**
     * Present only when this run used multi-pass. Lets the caller say what
     * actually happened -- "3 passes, merged" versus "2 of 3 passes, merge
     * failed" -- instead of silently presenting a degraded result as if it
     * were the full one.
     */
    multiPass?: {
        roundsRequested: number;
        passesUsed: number;
        merged: boolean;
        /**
         * How the run went, in one line. Counts and outcomes only -- safe for
         * the unencrypted job row, unlike anything derived from the replies.
         */
        detail: string;
    };
}

/** Which transcript an Organization summary is made from, most preferred first. */
const ORG_SUMMARY_SOURCE_ORDER = ["riffado", "mixed", "plaud"] as const;

/**
 * The transcript an Organization summary is made from, of those its owner
 * holds: a provider's output over an edit, and both over an import.
 */
async function findOrgSummarySource(
    recordingId: string,
    ownerUserId: string,
): Promise<typeof transcriptions.$inferSelect | undefined> {
    const rows = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, ownerUserId),
            ),
        );
    for (const source of ORG_SUMMARY_SOURCE_ORDER) {
        const row = rows.find((item) => item.source === source);
        if (row) return row;
    }
    return undefined;
}

/** Coarse length bucket -- never send raw transcript length or content. */
function bucketLength(chars: number): string {
    if (chars < 2_000) return "short";
    if (chars < 10_000) return "medium";
    if (chars < 50_000) return "long";
    return "very_long";
}

/**
 * Generate (or regenerate) a summary for a recording and persist it via
 * the shared `upsertEnhancement` tombstone-aware upsert. Shared by the
 * manual `/api/recordings/[id]/summary` POST handler and the auto-summarize
 * path that runs after a successful transcription.
 *
 * Throws `AppError` on user-facing failures (no transcript, no provider,
 * tombstoned recording). Provider errors propagate verbatim so callers
 * can decide whether to retry or surface them.
 */
export async function generateSummaryForRecording(
    actorUserId: string,
    recordingId: string,
    opts: GenerateSummaryOptions = {},
): Promise<GenerateSummaryResult> {
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
    const orgView = ctx.view === "org";
    // The owner's rows in either view: a shared recording is one recording.
    const userId = ctx.contentUserId;
    // Before the provider is paid; the write checks again under the lock.
    const refusal = await contentWriterRefusalNow({
        recordingId,
        ownerUserId: ctx.ownerUserId,
        actorUserId: ctx.actorUserId,
    });
    if (refusal) throw writerRefusalError(refusal);

    const [recording] = await db
        .select(audioItemColumns)
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, ctx.ownerUserId),
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

    // A recording shared before sharing needed a named transcript may hold
    // only an import; the Organization summarizes what it has.
    const transcription = orgView
        ? await findOrgSummarySource(recordingId, userId)
        : (
              await db
                  .select()
                  .from(transcriptions)
                  .where(
                      and(
                          eq(transcriptions.recordingId, recordingId),
                          eq(transcriptions.userId, userId),
                          eq(transcriptions.source, "riffado"),
                      ),
                  )
                  .limit(1)
          )[0];

    if (!transcription) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "No custom transcription available. Transcribe the recording with your provider first.",
            400,
        );
    }

    // What the summary is told about tasks: the recording's date, the tasks
    // already decided on it, and open tasks its reviewer may close. Tasks
    // never cost the summary: without them it is made as before.
    const tasksContext = await loadTasksPromptContext({
        recording,
        transcriptionId: transcription.id,
        orgView,
        reviewer: await taskViewerById(
            orgView ? ctx.settingsUserId : ctx.ownerUserId,
        ),
    }).catch((error: unknown) => {
        console.error("[summary] task context unavailable:", error);
        return { text: "", refs: new Map<string, string>() };
    });

    // Content settings (prompts, language, merge prompt) follow the view;
    // the engine settings (multi-pass rounds) follow the actor, who pays.
    const [userSettingsRow] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, ctx.settingsUserId))
        .limit(1);
    const [actorSettingsRow] =
        ctx.actorUserId === ctx.settingsUserId
            ? [userSettingsRow]
            : await db
                  .select()
                  .from(userSettings)
                  .where(eq(userSettings.userId, ctx.actorUserId))
                  .limit(1);

    // `summaryPrompt` is jsonb-envelope encrypted at rest; legacy
    // plaintext rows pass through verbatim. A missing value reads as the
    // seeded built-ins.
    const promptConfig = normalizeSummaryPromptConfig(
        userSettingsRow?.summaryPrompt
            ? decryptJsonField(userSettingsRow.summaryPrompt)
            : null,
    );

    // Template resolution: explicit override > user default > built-in.
    // `usedPromptId` is the template actually used, which differs from the
    // requested one when that template was since deleted. It is returned to
    // the caller so it can warn instead of silently generating with a
    // different template than the one requested.
    const requestedPromptId = opts.presetId || promptConfig.selectedPrompt;
    const { id: usedPromptId, prompt: promptTemplate } = resolveTemplate(
        promptConfig,
        requestedPromptId,
        SUMMARY_TEMPLATE_KIND,
    );

    // Credentials: prefer the user's enhancement-default provider, fall
    // back to any configured provider that can actually summarize.
    const summaryModel = await summaryModelFor(ctx.actorUserId);
    const { credentials, model } = summaryModel;

    // Decrypt the transcript before sending it to the LLM. Plaintext is
    // the LLM's input contract; ciphertext lives only in the DB. Its
    // corrections applied, and the fingerprint of that kept, so the summary
    // can tell when they moved on.
    const input = await modelInput(transcription);
    const transcriptText = input.text;

    // Apply the AI output language directive via the system message rather
    // than the user prompt. This separates concerns: the user prompt carries
    // the JSON-shape contract (English keys), the system message carries the
    // output language. Smaller models tend to honor this split more reliably
    // than a combined prompt where language and JSON-shape rules compete.
    const outputLanguage = resolveAiOutputLanguage(
        userSettingsRow?.aiOutputLanguage,
        transcription.detectedLanguage ??
            userSettingsRow?.defaultTranscriptionLanguage,
    );
    const languageDirective = getAiOutputLanguageDirective(outputLanguage);
    // The merge never sees the transcript, so under `auto` it has to take
    // the language from the passes instead.
    const mergeLanguageDirective = getAiOutputLanguageDirective(
        outputLanguage,
        "extractions",
    );

    // `replaceAll` with a function replacer so (a) a custom prompt that
    // references `{transcription}` more than once gets every occurrence
    // expanded, and (b) `$` sequences in the transcript (e.g. `$1`, `$&`)
    // are inserted verbatim instead of being interpreted as
    // `String.prototype.replace` special patterns.
    // The task lists are data the user's recordings hold, so they go with
    // the user's message rather than the instructions.
    const selectedTemplate = promptConfig.templates.find(
        (template) => template.id === usedPromptId,
    );
    const localizedTemplate = localizedSummaryPrompt(
        usedPromptId,
        promptTemplate,
        outputLanguage,
        selectedTemplate?.prompt === null,
    );
    const prompt = [
        localizedTemplate.replaceAll("{transcription}", () => transcriptText),
        tasksContext.text,
    ]
        .filter(Boolean)
        .join("\n\n");

    const baseSystem =
        "You are a helpful assistant that summarizes audio transcriptions. Always respond with one raw JSON object and nothing else: no code fences, and no text before or after it. Markdown inside the JSON string values is expected.";
    const systemContent = [
        baseSystem,
        CONTENT_IS_DATA_DIRECTIVE,
        SUMMARY_MARKDOWN_DIRECTIVE,
        SUMMARY_SPEAKER_DIRECTIVE,
        SUMMARY_TASKS_DIRECTIVE,
        languageDirective,
    ]
        .filter(Boolean)
        .join(" ");

    // Multi-pass applies to the auto path only if separately enabled: a manual
    // summary is one recording the user is waiting on, while a sync can fire a
    // dozen, and each one multiplies by `rounds`.
    const multiPassOn =
        actorSettingsRow?.summaryMultiPass === true &&
        (opts.trigger !== "auto" || actorSettingsRow?.summaryMultiPassAuto);

    const { payload, multiPass } = await runSummary({
        model: summaryModel,
        usage: {
            itemId: recordingId,
            ownerUserId: ctx.ownerUserId,
            payerUserId: ctx.actorUserId,
        },
        systemContent,
        prompt,
        mergeSystem: (mergePrompt) =>
            [
                mergePrompt,
                CONTENT_IS_DATA_DIRECTIVE,
                SUMMARY_MARKDOWN_DIRECTIVE,
                SUMMARY_SPEAKER_DIRECTIVE,
                SUMMARY_TASKS_MERGE_DIRECTIVE,
                mergeLanguageDirective,
            ]
                .filter(Boolean)
                .join("\n\n"),
        multiPass: multiPassOn
            ? {
                  rounds: actorSettingsRow?.summaryMultiPassRounds ?? null,
                  // User-authored, so encrypted at rest like the summary prompts.
                  mergePrompt: userSettingsRow?.summaryMergePrompt
                      ? decryptText(userSettingsRow.summaryMergePrompt)
                      : null,
              }
            : null,
        onProgress: opts.onProgress,
    });

    const { summary, keyPoints, actionItems } = payload;
    const tasks = await resolveTaskProposals({
        source: "riffado",
        items: payload.taskItems,
        updates: payload.taskUpdates,
        refs: tasksContext.refs,
        ownerUserId: ctx.ownerUserId,
        transcriptionId: transcription.id,
        turns: input.turns,
        language: transcription.detectedLanguage,
        orgView,
        summaryText: summary,
    }).catch((error: unknown) => {
        console.error("[summary] task proposals unavailable:", error);
        return undefined;
    });

    const { committed, reason } = await upsertEnhancement({
        userId,
        recordingId,
        transcriptionId: transcription.id,
        summary,
        keyPoints,
        actionItems,
        source: "riffado",
        provider: credentials.provider,
        model,
        multiPass,
        inputFingerprint: input.fingerprint,
        allowReaped: (opts.trigger ?? "manual") === "manual",
        actorUserId: ctx.actorUserId,
        jobId: opts.jobId,
        tasks,
    });

    if (!committed) {
        if (reason === "cancelled") {
            throw new AppError(
                ErrorCode.NOT_FOUND,
                "The run was cancelled before it finished",
                410,
            );
        }
        if (reason) throw writerRefusalError(reason);
        throw new AppError(ErrorCode.NOT_FOUND, "Recording was deleted", 410);
    }

    await exportRecordingSidecarsIfEnabled(
        userId,
        recordingId,
        "summary",
        "riffado",
    );
    await notifyIfShared(recordingId);

    await captureServerEvent({
        distinctId: ctx.actorUserId,
        event: "summary_generated",
        properties: {
            trigger: opts.trigger ?? "manual",
            provider: credentials.provider,
            transcript_length_bucket: bucketLength(transcriptText.length),
            // Counts only -- never prompt or transcript content. Recorded
            // because a degraded run (fewer passes used than requested, or no
            // merge) is otherwise indistinguishable from a clean one.
            multi_pass: multiPass !== undefined,
            multi_pass_rounds: multiPass?.roundsRequested,
            multi_pass_passes_used: multiPass?.passesUsed,
            multi_pass_merged: multiPass?.merged,
        },
    });

    return {
        ownerUserId: ctx.ownerUserId,
        summary,
        keyPoints,
        actionItems,
        provider: credentials.provider,
        model,
        promptId: usedPromptId,
        promptFallback: usedPromptId !== requestedPromptId,
        multiPass,
    };
}
