import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { buildNameResolver } from "@/lib/knowledge/attribution";
import { projectTranscript } from "@/lib/knowledge/project-transcript";
import {
    inferSummarySpeakerNumberOffset,
    projectSummarySpeakerReferencesForExport,
} from "@/lib/knowledge/speaker-references";
import {
    reconcileRecordingStorage,
    recordingStorageNeedsReconciliation,
} from "@/lib/recordings/reconcile-storage";
import { sidecarKey } from "@/lib/recordings/storage-files";
import { createUserStorageProvider } from "@/lib/storage/factory";
import {
    formatSpeakerLabel,
    parseSpeakerTurns,
} from "@/lib/transcription/diarization";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import type { SpeakerNameResolver } from "@/lib/transcription/turns";
import { resolvePrimaryTranscript } from "@/lib/v1/serialize";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export type SidecarKind = "transcript" | "summary";

/** Which sidecars a call should write. Both false is a no-op. */
export interface SidecarSelection {
    transcript: boolean;
    summary: boolean;
}

export interface TranscriptSidecarInput {
    title: string;
    recordedAt: Date;
    durationMs: number;
    language: string | null;
    provider: string;
    model: string;
    source: string;
    text: string;
    participants: string[];
}

export interface SummarySidecarInput {
    title: string;
    recordedAt: Date;
    provider: string;
    model: string;
    source: string;
    transcriptSource: string;
    summary: string | null;
    keyPoints: string[];
    actionItems: string[];
    participants: string[];
}

export interface RecordingMarkdownDocument {
    content: string;
    filename: string;
}

interface SidecarProjectionContext {
    primary: typeof transcriptions.$inferSelect | null;
    resolve: SpeakerNameResolver | undefined;
    participants: string[];
    speakers: string[];
}

export { sidecarKey } from "@/lib/recordings/storage-files";

/** Markdown document for a transcript, with YAML front matter. */
export function buildTranscriptMarkdown(input: TranscriptSidecarInput): string {
    const frontMatter = [
        "---",
        `title: ${yamlString(input.title)}`,
        `recorded: ${input.recordedAt.toISOString()}`,
        ...participantsFrontMatter(input.participants),
        `duration: ${formatDuration(input.durationMs)}`,
        `language: ${input.language ? yamlString(input.language) : "null"}`,
        `source: ${yamlString(input.source)}`,
        `provider: ${yamlString(input.provider)}`,
        `model: ${yamlString(input.model)}`,
        "---",
    ].join("\n");

    return `${frontMatter}\n\n# ${input.title}\n\n${input.text.trim()}\n`;
}

/** Markdown document for a summary, with YAML front matter. */
export function buildSummaryMarkdown(input: SummarySidecarInput): string {
    const frontMatter = [
        "---",
        `title: ${yamlString(input.title)}`,
        `recorded: ${input.recordedAt.toISOString()}`,
        ...participantsFrontMatter(input.participants),
        `source: ${yamlString(input.source)}`,
        `transcript_source: ${yamlString(input.transcriptSource)}`,
        `provider: ${yamlString(input.provider)}`,
        `model: ${yamlString(input.model)}`,
        "---",
    ].join("\n");

    const sections: string[] = [`# ${input.title}`];

    const summary = input.summary?.trim();
    if (summary) {
        sections.push(`## Summary\n\n${summary}`);
    }
    if (input.keyPoints.length > 0) {
        sections.push(`## Key points\n\n${bulletList(input.keyPoints)}`);
    }
    if (input.actionItems.length > 0) {
        sections.push(`## Action items\n\n${bulletList(input.actionItems)}`);
    }

    return `${frontMatter}\n\n${sections.join("\n\n")}\n`;
}

/**
 * Write the requested sidecars for one recording and return the kinds that
 * were actually written. Kinds with no content yet (no transcript, no
 * summary) are skipped rather than written empty.
 *
 * Throws on storage failure; callers treat export as best-effort and must
 * not let a failure here roll back the transcript or summary itself.
 */
export async function exportRecordingSidecars(
    userId: string,
    recordingId: string,
    selection: SidecarSelection,
    source?: string,
): Promise<SidecarKind[]> {
    if (!selection.transcript && !selection.summary) return [];

    const [recording] = await db
        .select()
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);

    if (!recording) return [];

    const title = decryptText(recording.filename);
    const written: SidecarKind[] = [];
    let storagePath = recording.storagePath;
    let storage: Awaited<ReturnType<typeof createUserStorageProvider>> | null =
        null;

    const storageState = {
        id: recording.id,
        userId,
        title,
        storagePath: recording.storagePath,
        storageFilename: recording.storageFilename,
    };
    if (recordingStorageNeedsReconciliation(storageState)) {
        const reconciled = await reconcileRecordingStorage({
            ...storageState,
        });
        storagePath = reconciled.storagePath;
    }

    const selectedKinds: SidecarKind[] = [
        ...(selection.transcript ? (["transcript"] as const) : []),
        ...(selection.summary ? (["summary"] as const) : []),
    ];
    for (const kind of selectedKinds) {
        const sources = source
            ? [source]
            : await contentSources(userId, recordingId, kind);
        for (const contentSource of sources) {
            const document = await renderRecordingMarkdownDocument(
                userId,
                recording,
                title,
                kind,
                storagePath,
                contentSource,
            );
            if (!document) continue;

            storage ??= await createUserStorageProvider(userId);
            await storage.uploadFile(
                sidecarKey(storagePath, kind, contentSource),
                Buffer.from(document.content, "utf8"),
                MARKDOWN_CONTENT_TYPE,
            );
            written.push(kind);
        }
    }

    return written;
}

/** Build the same portable Markdown document used for disk sidecars. */
export async function getRecordingMarkdownDocument(
    userId: string,
    recordingId: string,
    kind: SidecarKind,
    source?: string,
): Promise<RecordingMarkdownDocument | null> {
    const [recording] = await db
        .select()
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) return null;

    const title = decryptText(recording.filename);
    return renderRecordingMarkdownDocument(
        userId,
        recording,
        title,
        kind,
        recording.storagePath,
        source,
    );
}

async function renderRecordingMarkdownDocument(
    userId: string,
    recording: typeof recordings.$inferSelect,
    title: string,
    kind: SidecarKind,
    storagePath: string,
    source?: string,
): Promise<RecordingMarkdownDocument | null> {
    if (kind === "transcript") {
        const projection = await loadSidecarProjectionContext(
            userId,
            recording.id,
            source,
        );
        const { primary } = projection;
        if (!primary) return null;
        const filename = sidecarKey(storagePath, kind, primary.source)
            .split("/")
            .at(-1);
        if (!filename) return null;

        const text = projectTranscript(
            {
                id: primary.id,
                text: decryptText(primary.text),
                turns: primary.turns,
            },
            projection.resolve,
        );
        if (!text?.trim()) return null;

        return {
            filename,
            content: buildTranscriptMarkdown({
                title,
                recordedAt: recording.startTime,
                durationMs: recording.duration,
                language: primary.detectedLanguage,
                provider: primary.provider,
                model: primary.model,
                source: primary.source,
                text,
                participants: projection.participants,
            }),
        };
    }

    const enhancements = await db
        .select()
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.recordingId, recording.id),
                eq(aiEnhancements.userId, userId),
            ),
        );
    const enhancement = source
        ? enhancements.find((candidate) => candidate.source === source)
        : await preferredEnhancement(userId, enhancements);
    if (!enhancement) return null;

    const projection = await loadSidecarProjectionContext(
        userId,
        recording.id,
        enhancement.source,
        enhancement.transcriptionId,
    );
    const filename = sidecarKey(storagePath, kind, enhancement.source)
        .split("/")
        .at(-1);
    if (!filename) return null;

    const summaryValue = decryptText(enhancement.summary) ?? null;
    const keyPointValues = stringArray(
        decryptJsonField<unknown>(enhancement.keyPoints),
    );
    const actionItemValues = stringArray(
        decryptJsonField<unknown>(enhancement.actionItems),
    );
    const speakerNumberOffset = inferSummarySpeakerNumberOffset(
        [summaryValue ?? "", ...keyPointValues, ...actionItemValues].join("\n"),
        projection.speakers,
    );
    const summary = summaryValue
        ? projectSummarySpeakerReferencesForExport(
              summaryValue,
              projection.resolve,
              speakerNumberOffset,
          )
        : null;
    const keyPoints = keyPointValues.map((item) =>
        projectSummarySpeakerReferencesForExport(
            item,
            projection.resolve,
            speakerNumberOffset,
        ),
    );
    const actionItems = actionItemValues.map((item) =>
        projectSummarySpeakerReferencesForExport(
            item,
            projection.resolve,
            speakerNumberOffset,
        ),
    );
    if (
        !summary?.trim() &&
        keyPoints.length === 0 &&
        actionItems.length === 0
    ) {
        return null;
    }

    return {
        filename,
        content: buildSummaryMarkdown({
            title,
            recordedAt: recording.startTime,
            provider: enhancement.provider,
            model: enhancement.model,
            source: enhancement.source,
            transcriptSource: projection.primary?.source ?? enhancement.source,
            summary,
            keyPoints,
            actionItems,
            participants: projection.participants,
        }),
    };
}

async function loadSidecarProjectionContext(
    userId: string,
    recordingId: string,
    source?: string,
    transcriptionId?: string | null,
): Promise<SidecarProjectionContext> {
    const rows = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
            ),
        );

    const [settings] = await db
        .select({ preferred: userSettings.preferredTranscriptSource })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);

    const primary =
        (transcriptionId
            ? rows.find((transcript) => transcript.id === transcriptionId)
            : undefined) ??
        (source
            ? rows.find((transcript) => transcript.source === source)
            : resolvePrimaryTranscript(rows, settings?.preferred ?? "plaud")) ??
        null;
    const resolve = primary
        ? await buildNameResolver(userId, primary.id)
        : undefined;
    const speakers = primary ? transcriptSpeakerLabels(primary) : [];
    return {
        primary,
        resolve,
        participants: participantNames(speakers, resolve),
        speakers,
    };
}

/** Rewrite only sidecars that already exist for this recording. */
export async function rewriteExistingRecordingSidecars(
    userId: string,
    recordingId: string,
): Promise<void> {
    const [recording] = await db
        .select({ storagePath: recordings.storagePath })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) return;

    const storage = await createUserStorageProvider(userId);
    const transcriptSources = await contentSources(
        userId,
        recordingId,
        "transcript",
    );
    const summarySources = await contentSources(userId, recordingId, "summary");
    const legacyTranscriptKey = sidecarKey(recording.storagePath, "transcript");
    const legacySummaryKey = sidecarKey(recording.storagePath, "summary");
    const [legacyTranscript, legacySummary] = await Promise.all([
        storage.exists(legacyTranscriptKey),
        storage.exists(legacySummaryKey),
    ]);
    let migratedLegacyTranscript = false;
    let migratedLegacySummary = false;

    for (const source of transcriptSources) {
        if (
            legacyTranscript ||
            (await storage.exists(
                sidecarKey(recording.storagePath, "transcript", source),
            ))
        ) {
            const written = await exportRecordingSidecars(
                userId,
                recordingId,
                { transcript: true, summary: false },
                source,
            );
            if (written.includes("transcript")) {
                migratedLegacyTranscript ||= legacyTranscript;
            }
        }
    }
    for (const source of summarySources) {
        if (
            legacySummary ||
            (await storage.exists(
                sidecarKey(recording.storagePath, "summary", source),
            ))
        ) {
            const written = await exportRecordingSidecars(
                userId,
                recordingId,
                { transcript: false, summary: true },
                source,
            );
            if (written.includes("summary")) {
                migratedLegacySummary ||= legacySummary;
            }
        }
    }
    if (migratedLegacyTranscript) {
        await storage.deleteFile(legacyTranscriptKey);
    }
    if (migratedLegacySummary) await storage.deleteFile(legacySummaryKey);
}

/** Best-effort wrapper for user-facing mutation and attribution paths. */
export async function refreshExistingRecordingSidecars(
    userId: string,
    recordingId: string,
): Promise<void> {
    try {
        await rewriteExistingRecordingSidecars(userId, recordingId);
    } catch (error) {
        console.error(
            `Failed to refresh document sidecars for recording ${recordingId}:`,
            error,
        );
    }
}

/** Best-effort removal of one source-specific sidecar after content deletion. */
export async function removeRecordingSidecar(
    userId: string,
    recordingId: string,
    kind: SidecarKind,
    source: string,
): Promise<void> {
    try {
        const [recording] = await db
            .select({ storagePath: recordings.storagePath })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1);
        if (!recording) return;
        const storage = await createUserStorageProvider(userId);
        const key = sidecarKey(recording.storagePath, kind, source);
        if (await storage.exists(key)) await storage.deleteFile(key);
    } catch (error) {
        console.error(
            `Failed to remove ${source} ${kind} sidecar for recording ${recordingId}:`,
            error,
        );
    }
}

/**
 * Best-effort variant used by the transcription and summary pipelines.
 * Reads the user's toggles, writes what they asked for, and swallows any
 * failure so a storage problem never costs the user their transcript.
 */
export async function exportRecordingSidecarsIfEnabled(
    userId: string,
    recordingId: string,
    kind: SidecarKind,
    source?: string,
): Promise<void> {
    try {
        const [settings] = await db
            .select({
                transcript: userSettings.autoExportTranscript,
                summary: userSettings.autoExportSummary,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);

        if (!settings) return;

        const enabled =
            kind === "transcript" ? settings.transcript : settings.summary;
        if (!enabled) return;

        await exportRecordingSidecars(
            userId,
            recordingId,
            {
                transcript: kind === "transcript",
                summary: kind === "summary",
            },
            source,
        );
    } catch (error) {
        console.error(
            `Failed to export ${kind} sidecar for recording ${recordingId}:`,
            error,
        );
    }
}

async function contentSources(
    userId: string,
    recordingId: string,
    kind: SidecarKind,
): Promise<string[]> {
    const rows =
        kind === "transcript"
            ? await db
                  .select({ source: transcriptions.source })
                  .from(transcriptions)
                  .where(
                      and(
                          eq(transcriptions.recordingId, recordingId),
                          eq(transcriptions.userId, userId),
                      ),
                  )
            : await db
                  .select({ source: aiEnhancements.source })
                  .from(aiEnhancements)
                  .where(
                      and(
                          eq(aiEnhancements.recordingId, recordingId),
                          eq(aiEnhancements.userId, userId),
                      ),
                  );
    return [...new Set(rows.map((row) => row.source))];
}

async function preferredEnhancement(
    userId: string,
    enhancements: Array<typeof aiEnhancements.$inferSelect>,
): Promise<typeof aiEnhancements.$inferSelect | undefined> {
    const [settings] = await db
        .select({ preferred: userSettings.preferredTranscriptSource })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    const preferred = settings?.preferred ?? "plaud";
    return (
        enhancements.find((enhancement) => enhancement.source === preferred) ??
        enhancements.find((enhancement) => enhancement.source === "riffado") ??
        enhancements[0]
    );
}

function bulletList(items: string[]): string {
    return items.map((item) => `- ${item}`).join("\n");
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
}

function yamlString(value: string): string {
    return JSON.stringify(value);
}

function participantsFrontMatter(participants: string[]): string[] {
    if (participants.length === 0) return ["participants: []"];
    return [
        "participants:",
        ...participants.map((participant) => `  - ${yamlString(participant)}`),
    ];
}

function participantNames(
    labels: readonly string[],
    resolve: SpeakerNameResolver | undefined,
): string[] {
    const names: string[] = [];

    for (const label of labels) {
        const name = resolve?.(label) ?? formatSpeakerLabel(label);
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

function transcriptSpeakerLabels(
    transcript: typeof transcriptions.$inferSelect,
): string[] {
    const storedTurns = readTranscriptTurns(transcript);
    const parsedTurns = storedTurns
        ? null
        : parseSpeakerTurns(decryptText(transcript.text));
    return storedTurns
        ? storedTurns.map((turn) => turn.speaker)
        : (parsedTurns?.map((turn) => turn.speaker) ?? []);
}

function formatDuration(durationMs: number): string {
    const total = Math.max(0, Math.round(durationMs / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return [hours, minutes, seconds]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
}
