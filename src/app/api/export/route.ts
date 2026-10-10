import { and, eq, getTableColumns } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { audioItemColumns, recordingItemJoin } from "@/db/items";
import {
    aiEnhancements,
    chatterItems,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { archivedRecordingCondition } from "@/lib/export/archive-scope";
import { isExportFormat } from "@/lib/export/formats";
import { resolveArchiveScope } from "@/lib/export/resolve-archive-scope";
import {
    buildOrgResolverMap,
    buildResolverMap,
    projectTranscript,
} from "@/lib/knowledge/project-transcript";
import { confirmedOverlays } from "@/lib/learn/llm-input";
import { captureServerEvent } from "@/lib/posthog-server";
import { type ArchivedTask, tasksForArchive } from "@/lib/tasks/archive";
import { resolvePrimaryTranscript } from "@/lib/v1/serialize";

// GET - Export recordings in specified format
export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const { searchParams } = new URL(request.url);
    // Read the raw query param (may be null) so the user-settings
    // fallback below actually has a chance to apply. Defaulting `format`
    // to "json" up here would mask `settings.defaultExportFormat`
    // entirely.
    const formatParam = searchParams.get("format");

    // Get user settings for default format
    const [settings] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, session.user.id))
        .limit(1);

    const exportFormat = formatParam || settings?.defaultExportFormat || "json";

    // Reject an unsupported format before running the four queries below.
    // The `default` branch of the switch still catches it, but only after
    // the whole dataset has been read and decrypted for nothing. A stored
    // `defaultExportFormat` can reach here without passing through the
    // settings validator (older rows, direct DB edits), so this is not
    // purely redundant with it.
    if (!isExportFormat(exportFormat)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid export format",
            400,
            {
                field: "format",
            },
        );
    }

    // The account decides whose recordings: its own, or for the
    // organization account every shared one. Never both.
    const scope = await resolveArchiveScope(session.user.id);
    const userRecordings = await db
        .select(audioItemColumns)
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(archivedRecordingCondition(scope));

    // The rows the recordings' owners hold, of live recordings only: a
    // deleted one's never reach the file.
    const recordingIds = userRecordings.map((r) => r.id);
    const userTranscriptions =
        recordingIds.length > 0
            ? await db
                  .select(getTableColumns(transcriptions))
                  .from(transcriptions)
                  .innerJoin(
                      recordings,
                      and(
                          eq(recordings.id, transcriptions.recordingId),
                          eq(recordings.userId, transcriptions.userId),
                      ),
                  )
                  .where(archivedRecordingCondition(scope))
            : [];

    const userEnhancements =
        recordingIds.length > 0
            ? await db
                  .select(getTableColumns(aiEnhancements))
                  .from(aiEnhancements)
                  .innerJoin(
                      recordings,
                      and(
                          eq(recordings.id, aiEnhancements.itemId),
                          eq(recordings.userId, aiEnhancements.userId),
                      ),
                  )
                  .where(archivedRecordingCondition(scope))
            : [];
    // Decrypt content fields up front so each format branch can rely on
    // plaintext. The export file is the user's plaintext data — they own
    // it once it leaves the server. `summary` is a `text` column
    // (encryptText); `actionItems`/`keyPoints` are `jsonb` envelopes
    // (encryptJsonField) -- same at-rest scheme the summary API itself
    // decrypts before returning to the client.
    const enhancementMap = new Map<
        string,
        Array<
            (typeof userEnhancements)[number] & {
                summary: string;
                actionItems: string[];
                keyPoints: string[];
            }
        >
    >();
    for (const enhancement of userEnhancements) {
        const group = enhancementMap.get(enhancement.itemId) ?? [];
        group.push({
            ...enhancement,
            summary: decryptText(enhancement.summary) ?? "",
            actionItems:
                decryptJsonField<string[]>(enhancement.actionItems) ?? [],
            keyPoints: decryptJsonField<string[]>(enhancement.keyPoints) ?? [],
        });
        enhancementMap.set(enhancement.itemId, group);
    }

    // Speaker names are applied here rather than stored: the exported file
    // is a rendering for the user, so it should read the way the app does.
    // Only confirmed attributions project; a machine guess never reaches a
    // file the user will treat as a record.
    const transcriptionIds = userTranscriptions.map((t) => t.id);
    const resolvers =
        scope.kind === "personal"
            ? await buildResolverMap(scope.userId, transcriptionIds)
            : await buildOrgResolverMap(transcriptionIds);
    const transcriptionGroups = new Map<
        string,
        Array<
            (typeof userTranscriptions)[number] & {
                text: string;
            }
        >
    >();
    // Every transcript's confirmed corrections, read at once: on a shared
    // recording of a person's own export, only those they made.
    const overlays =
        userTranscriptions.length > 0
            ? await confirmedOverlays(
                  scope.kind === "personal"
                      ? { ownerUserId: scope.userId, ownerAuthoredOnly: true }
                      : { organization: true },
              )
            : new Map<string, never[]>();
    for (const transcript of userTranscriptions) {
        const group = transcriptionGroups.get(transcript.recordingId) ?? [];
        group.push({
            ...transcript,
            // Its confirmed corrections applied, as people read it.
            text: projectTranscript(
                {
                    id: transcript.id,
                    text: decryptText(transcript.text),
                    turns: transcript.turns,
                },
                resolvers.get(transcript.id),
                overlays.get(transcript.id) ?? [],
            ),
        });
        transcriptionGroups.set(transcript.recordingId, group);
    }
    const taskMap =
        exportFormat === "json"
            ? await tasksForArchive(scope, recordingIds)
            : new Map<string, ArchivedTask[]>();
    const preferredSource = settings?.preferredTranscriptSource ?? "plaud";
    const transcriptionMap = new Map(
        Array.from(transcriptionGroups, ([recordingId, rows]) => [
            recordingId,
            resolvePrimaryTranscript(rows, preferredSource),
        ]),
    );
    const decryptedRecordings = userRecordings.map((r) => ({
        ...r,
        filename: decryptText(r.title),
    }));

    // Format export data
    let exportData: string;
    let contentType: string;
    let filename: string;

    switch (exportFormat) {
        case "json":
            exportData = JSON.stringify(
                decryptedRecordings.map((recording) => {
                    const transcripts =
                        transcriptionGroups.get(recording.id) ?? [];
                    const enhancements = enhancementMap.get(recording.id) ?? [];
                    const enhancement =
                        enhancements.find(
                            (item) => item.source === preferredSource,
                        ) ??
                        enhancements.find(
                            (item) => item.source === "riffado",
                        ) ??
                        enhancements[0];
                    return {
                        id: recording.id,
                        filename: recording.filename,
                        duration: recording.duration,
                        startTime: recording.occurredAt,
                        filesize: recording.filesize,
                        transcription:
                            transcriptionMap.get(recording.id)?.text || null,
                        transcriptions: transcripts.map((item) => ({
                            id: item.id,
                            source: item.source,
                            provider: item.provider,
                            model: item.model,
                            detectedLanguage: item.detectedLanguage,
                            text: item.text,
                        })),
                        summary: enhancement
                            ? {
                                  summary: enhancement.summary,
                                  actionItems: enhancement.actionItems,
                                  keyPoints: enhancement.keyPoints,
                              }
                            : null,
                        summaries: enhancements.map((item) => ({
                            id: item.id,
                            transcriptionId: item.transcriptionId,
                            source: item.source,
                            provider: item.provider,
                            model: item.model,
                            summary: item.summary,
                            actionItems: item.actionItems,
                            keyPoints: item.keyPoints,
                        })),
                        tasks: taskMap.get(recording.id) ?? [],
                    };
                }),
                null,
                2,
            );
            contentType = "application/json";
            filename = `recordings-${new Date().toISOString().split("T")[0]}.json`;
            break;

        case "txt":
            exportData = decryptedRecordings
                .map((recording) => {
                    const transcription = transcriptionMap.get(recording.id);
                    return `${recording.filename}\n${new Date(recording.occurredAt).toISOString()}\n${transcription?.text || "No transcription"}\n\n---\n\n`;
                })
                .join("");
            contentType = "text/plain";
            filename = `recordings-${new Date().toISOString().split("T")[0]}.txt`;
            break;

        case "srt":
            // SRT format for subtitles
            exportData = decryptedRecordings
                .flatMap((recording, index) => {
                    const transcription = transcriptionMap.get(recording.id);
                    if (!transcription?.text) return [];
                    const startTime = new Date(recording.occurredAt);
                    const endTime = new Date(
                        startTime.getTime() + recording.duration,
                    );
                    const formatSRTTime = (date: Date) => {
                        const hours = date
                            .getUTCHours()
                            .toString()
                            .padStart(2, "0");
                        const minutes = date
                            .getUTCMinutes()
                            .toString()
                            .padStart(2, "0");
                        const seconds = date
                            .getUTCSeconds()
                            .toString()
                            .padStart(2, "0");
                        const ms = date
                            .getUTCMilliseconds()
                            .toString()
                            .padStart(3, "0");
                        return `${hours}:${minutes}:${seconds},${ms}`;
                    };
                    return [
                        `${index + 1}\n${formatSRTTime(startTime)} --> ${formatSRTTime(endTime)}\n${transcription.text}\n\n`,
                    ];
                })
                .join("");
            contentType = "text/plain";
            filename = `recordings-${new Date().toISOString().split("T")[0]}.srt`;
            break;

        case "vtt":
            // WebVTT format
            exportData = `WEBVTT\n\n${decryptedRecordings
                .flatMap((recording) => {
                    const transcription = transcriptionMap.get(recording.id);
                    if (!transcription?.text) return [];
                    const startTime = new Date(recording.occurredAt);
                    const endTime = new Date(
                        startTime.getTime() + recording.duration,
                    );
                    const formatVTTTime = (date: Date) => {
                        const hours = date
                            .getUTCHours()
                            .toString()
                            .padStart(2, "0");
                        const minutes = date
                            .getUTCMinutes()
                            .toString()
                            .padStart(2, "0");
                        const seconds = date
                            .getUTCSeconds()
                            .toString()
                            .padStart(2, "0");
                        const ms = date
                            .getUTCMilliseconds()
                            .toString()
                            .padStart(3, "0");
                        return `${hours}:${minutes}:${seconds}.${ms}`;
                    };
                    return [
                        `${formatVTTTime(startTime)} --> ${formatVTTTime(endTime)}\n${transcription.text}\n\n`,
                    ];
                })
                .join("")}`;
            contentType = "text/vtt";
            filename = `recordings-${new Date().toISOString().split("T")[0]}.vtt`;
            break;

        default:
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Invalid export format",
                400,
                { field: "format" },
            );
    }

    await captureServerEvent({
        distinctId: session.user.id,
        event: "data_exported",
        properties: {
            format: exportFormat,
            recording_count: userRecordings.length,
        },
    });

    return new NextResponse(exportData, {
        headers: {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${filename}"`,
        },
    });
});
