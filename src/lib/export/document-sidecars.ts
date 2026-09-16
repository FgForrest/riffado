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
import { projectSummarySpeakerReferencesForExport } from "@/lib/knowledge/speaker-references";
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

    const projection = await loadSidecarProjectionContext(userId, recordingId);

    const selectedKinds: SidecarKind[] = [
        ...(selection.transcript ? (["transcript"] as const) : []),
        ...(selection.summary ? (["summary"] as const) : []),
    ];
    for (const kind of selectedKinds) {
        const document = await renderRecordingMarkdownDocument(
            userId,
            recording,
            title,
            projection,
            kind,
            storagePath,
        );
        if (!document) continue;

        storage ??= await createUserStorageProvider(userId);
        await storage.uploadFile(
            sidecarKey(storagePath, kind),
            Buffer.from(document.content, "utf8"),
            MARKDOWN_CONTENT_TYPE,
        );
        written.push(kind);
    }

    return written;
}

/** Build the same portable Markdown document used for disk sidecars. */
export async function getRecordingMarkdownDocument(
    userId: string,
    recordingId: string,
    kind: SidecarKind,
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
    const projection = await loadSidecarProjectionContext(userId, recordingId);
    return renderRecordingMarkdownDocument(
        userId,
        recording,
        title,
        projection,
        kind,
        recording.storagePath,
    );
}

async function renderRecordingMarkdownDocument(
    userId: string,
    recording: typeof recordings.$inferSelect,
    title: string,
    projection: SidecarProjectionContext,
    kind: SidecarKind,
    storagePath: string,
): Promise<RecordingMarkdownDocument | null> {
    const filename = sidecarKey(storagePath, kind).split("/").at(-1);
    if (!filename) return null;

    if (kind === "transcript") {
        const { primary } = projection;
        if (!primary) return null;

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

    const [enhancement] = await db
        .select()
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.recordingId, recording.id),
                eq(aiEnhancements.userId, userId),
            ),
        )
        .limit(1);
    if (!enhancement) return null;

    const summaryValue = decryptText(enhancement.summary) ?? null;
    const summary = summaryValue
        ? projectSummarySpeakerReferencesForExport(
              summaryValue,
              projection.resolve,
          )
        : null;
    const keyPoints = stringArray(
        decryptJsonField<unknown>(enhancement.keyPoints),
    ).map((item) =>
        projectSummarySpeakerReferencesForExport(item, projection.resolve),
    );
    const actionItems = stringArray(
        decryptJsonField<unknown>(enhancement.actionItems),
    ).map((item) =>
        projectSummarySpeakerReferencesForExport(item, projection.resolve),
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

    const primary = resolvePrimaryTranscript(
        rows,
        settings?.preferred ?? "plaud",
    );
    const resolve = primary
        ? await buildNameResolver(userId, primary.id)
        : undefined;
    return {
        primary,
        resolve,
        participants: primary ? participantNames(primary, resolve) : [],
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
    const [transcript, summary] = await Promise.all([
        storage.exists(sidecarKey(recording.storagePath, "transcript")),
        storage.exists(sidecarKey(recording.storagePath, "summary")),
    ]);
    if (!transcript && !summary) return;

    await exportRecordingSidecars(userId, recordingId, {
        transcript,
        summary,
    });
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

/**
 * Best-effort variant used by the transcription and summary pipelines.
 * Reads the user's toggles, writes what they asked for, and swallows any
 * failure so a storage problem never costs the user their transcript.
 */
export async function exportRecordingSidecarsIfEnabled(
    userId: string,
    recordingId: string,
    kind: SidecarKind,
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

        await exportRecordingSidecars(userId, recordingId, {
            transcript: kind === "transcript",
            summary: kind === "summary",
        });
    } catch (error) {
        console.error(
            `Failed to export ${kind} sidecar for recording ${recordingId}:`,
            error,
        );
    }
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
    transcript: typeof transcriptions.$inferSelect,
    resolve: SpeakerNameResolver | undefined,
): string[] {
    const storedTurns = readTranscriptTurns(transcript);
    const parsedTurns = storedTurns
        ? null
        : parseSpeakerTurns(decryptText(transcript.text));
    const labels = storedTurns
        ? storedTurns.map((turn) => turn.speaker)
        : (parsedTurns?.map((turn) => turn.speaker) ?? []);
    const names: string[] = [];

    for (const label of labels) {
        const name = resolve?.(label) ?? formatSpeakerLabel(label);
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
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
