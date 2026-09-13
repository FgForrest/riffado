import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { createUserStorageProvider } from "@/lib/storage/factory";
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
}

export interface SummarySidecarInput {
    title: string;
    recordedAt: Date;
    provider: string;
    model: string;
    summary: string | null;
    keyPoints: string[];
    actionItems: string[];
}

/**
 * Storage key for a recording's sidecar, derived from the audio key so the
 * two sit side by side: `user/Board meeting.mp3` becomes
 * `user/Board meeting.transcript.md`.
 */
export function sidecarKey(storagePath: string, kind: SidecarKind): string {
    const slash = storagePath.lastIndexOf("/");
    const dir = slash === -1 ? "" : storagePath.slice(0, slash + 1);
    const base = storagePath.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    return `${dir}${stem}.${kind}.md`;
}

/** Markdown document for a transcript, with YAML front matter. */
export function buildTranscriptMarkdown(input: TranscriptSidecarInput): string {
    const frontMatter = [
        "---",
        `title: ${yamlString(input.title)}`,
        `recorded: ${input.recordedAt.toISOString()}`,
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
    let storage: Awaited<ReturnType<typeof createUserStorageProvider>> | null =
        null;

    if (selection.transcript) {
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
            .select({
                preferred: userSettings.preferredTranscriptSource,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);

        const primary = resolvePrimaryTranscript(
            rows,
            settings?.preferred ?? "plaud",
        );

        if (primary) {
            const text = decryptText(primary.text);
            if (text?.trim()) {
                storage ??= await createUserStorageProvider(userId);
                await storage.uploadFile(
                    sidecarKey(recording.storagePath, "transcript"),
                    Buffer.from(
                        buildTranscriptMarkdown({
                            title,
                            recordedAt: recording.startTime,
                            durationMs: recording.duration,
                            language: primary.detectedLanguage,
                            provider: primary.provider,
                            model: primary.model,
                            source: primary.source,
                            text,
                        }),
                        "utf8",
                    ),
                    MARKDOWN_CONTENT_TYPE,
                );
                written.push("transcript");
            }
        }
    }

    if (selection.summary) {
        const [enhancement] = await db
            .select()
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.recordingId, recordingId),
                    eq(aiEnhancements.userId, userId),
                ),
            )
            .limit(1);

        if (enhancement) {
            const summary = decryptText(enhancement.summary) ?? null;
            const keyPoints = stringArray(
                decryptJsonField<unknown>(enhancement.keyPoints),
            );
            const actionItems = stringArray(
                decryptJsonField<unknown>(enhancement.actionItems),
            );

            if (summary?.trim() || keyPoints.length > 0 || actionItems.length) {
                storage ??= await createUserStorageProvider(userId);
                await storage.uploadFile(
                    sidecarKey(recording.storagePath, "summary"),
                    Buffer.from(
                        buildSummaryMarkdown({
                            title,
                            recordedAt: recording.startTime,
                            provider: enhancement.provider,
                            model: enhancement.model,
                            summary,
                            keyPoints,
                            actionItems,
                        }),
                        "utf8",
                    ),
                    MARKDOWN_CONTENT_TYPE,
                );
                written.push("summary");
            }
        }
    }

    return written;
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

function formatDuration(durationMs: number): string {
    const total = Math.max(0, Math.round(durationMs / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return [hours, minutes, seconds]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
}
