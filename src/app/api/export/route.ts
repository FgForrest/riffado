import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import {
    aiEnhancements,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { isExportFormat } from "@/lib/export/formats";
import {
    buildResolverMap,
    projectTranscript,
} from "@/lib/knowledge/project-transcript";
import { captureServerEvent } from "@/lib/posthog-server";
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

    // Get all recordings for user
    const userRecordings = await db
        .select()
        .from(recordings)
        .where(
            and(
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        );

    // Get transcriptions for all recordings
    const recordingIds = userRecordings.map((r) => r.id);
    const userTranscriptions =
        recordingIds.length > 0
            ? await db
                  .select()
                  .from(transcriptions)
                  .where(eq(transcriptions.userId, session.user.id))
            : [];

    const userEnhancements =
        recordingIds.length > 0
            ? await db
                  .select()
                  .from(aiEnhancements)
                  .where(eq(aiEnhancements.userId, session.user.id))
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
        const group = enhancementMap.get(enhancement.recordingId) ?? [];
        group.push({
            ...enhancement,
            summary: decryptText(enhancement.summary) ?? "",
            actionItems:
                decryptJsonField<string[]>(enhancement.actionItems) ?? [],
            keyPoints: decryptJsonField<string[]>(enhancement.keyPoints) ?? [],
        });
        enhancementMap.set(enhancement.recordingId, group);
    }

    // Speaker names are applied here rather than stored: the exported file
    // is a rendering for the user, so it should read the way the app does.
    // Only confirmed attributions project; a machine guess never reaches a
    // file the user will treat as a record.
    const resolvers = await buildResolverMap(
        session.user.id,
        userTranscriptions.map((t) => t.id),
    );
    const transcriptionGroups = new Map<
        string,
        Array<
            (typeof userTranscriptions)[number] & {
                text: string;
            }
        >
    >();
    for (const transcript of userTranscriptions) {
        const group = transcriptionGroups.get(transcript.recordingId) ?? [];
        group.push({
            ...transcript,
            text: projectTranscript(
                {
                    id: transcript.id,
                    text: decryptText(transcript.text),
                    turns: transcript.turns,
                },
                resolvers.get(transcript.id),
            ),
        });
        transcriptionGroups.set(transcript.recordingId, group);
    }
    const preferredSource = settings?.preferredTranscriptSource ?? "plaud";
    const transcriptionMap = new Map(
        Array.from(transcriptionGroups, ([recordingId, rows]) => [
            recordingId,
            resolvePrimaryTranscript(rows, preferredSource),
        ]),
    );
    const decryptedRecordings = userRecordings.map((r) => ({
        ...r,
        filename: decryptText(r.filename),
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
                        startTime: recording.startTime,
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
                    return `${recording.filename}\n${new Date(recording.startTime).toISOString()}\n${transcription?.text || "No transcription"}\n\n---\n\n`;
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
                    const startTime = new Date(recording.startTime);
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
                    const startTime = new Date(recording.startTime);
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
