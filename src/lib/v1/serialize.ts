import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    type AudioItemRow,
    audioItemColumns,
    recordingItemJoin,
} from "@/db/items";
import {
    aiEnhancements,
    chatterItems,
    plaudDevices,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import type { OverlayCorrection } from "@/lib/learn/render";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

type RecordingRow = AudioItemRow;
type DeviceRow = typeof plaudDevices.$inferSelect;
type TranscriptionRow = typeof transcriptions.$inferSelect;
type AiEnhancementRow = typeof aiEnhancements.$inferSelect;

export type RecordingCursor = {
    /**
     * The row's `updated_at` as an ISO timestamp in UTC, to the microsecond
     * (`recordingCursorUpdatedAt`); cursors issued before carry milliseconds.
     */
    updatedAt: string;
    id: string;
};

export type V1Transcript = {
    source: string;
    language: string | null;
    /** As heard: corrections never rewrite it. */
    text: string;
    provider: string;
    model: string;
    created_at: string;
    /**
     * The confirmed corrections on it, as an overlay: a turn and UTF-16
     * offsets into its text. On the transcript endpoint only.
     */
    corrections?: V1Correction[];
    /** The turns the corrections point into; with them only. */
    turns?: V1Turn[] | null;
};

export type V1Turn = {
    /** The provider's label, never a name. */
    speaker: string;
    start_ms: number;
    end_ms: number;
    text: string;
};

export type V1Correction = {
    id: string;
    turn_index: number;
    char_start: number;
    char_end: number;
    heard: string;
    /**
     * `correct` replaces what was heard; `link` keeps it and says what it
     * means; `fix` is a replacement the automatic correction pass made.
     */
    kind: "correct" | "link" | "fix";
    replacement: string | null;
    /** The name of whom or what it refers to. */
    meaning: string;
};

export type V1Summary = {
    text: string | null;
    action_items: string[] | null;
    key_points: string[] | null;
    provider: string;
    model: string;
    created_at: string;
};

export type V1Recording = {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
    recorded_at: string;
    duration_ms: number;
    filesize_bytes: number;
    device: {
        serial_number: string;
        name: string | null;
        model: string | null;
    } | null;
    has_transcription: boolean;
    has_summary: boolean;
    /**
     * True when the user's retention policy has deleted this recording's
     * audio. The row and its metadata survive, but `links.audio` will
     * answer 410 Gone. Without this a client cannot tell a deliberate
     * deletion from a broken instance until it tries the download.
     */
    audio_reaped: boolean;
    links: {
        self: string;
        transcript: string;
        audio: string;
    };
};

export type V1RecordingDetail = V1Recording & {
    /** The primary transcript (per the user's preferred source). Kept singular
     * for backward compatibility with clients that expect one transcript. */
    transcript: V1Transcript | null;
    /** Every transcript for the recording, one per source (e.g. the user's own
     * plus a Plaud-imported one). May hold 0, 1, or more entries. */
    transcripts: V1Transcript[];
    summary: V1Summary | null;
};

function toIso(value: Date): string {
    return value.toISOString();
}

function stringArrayOrNull(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const strings = value.filter((item): item is string => {
        return typeof item === "string";
    });
    return strings.length > 0 ? strings : [];
}

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/**
 * SQL: `recordings.updated_at` at full precision, in the form
 * `RecordingCursor.updatedAt` carries.
 */
export function recordingCursorUpdatedAt(): SQL<string> {
    return sql<string>`to_char(${recordings.updatedAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function encodeRecordingCursor(cursor: RecordingCursor): string {
    return Buffer.from(
        JSON.stringify({
            updatedAt: cursor.updatedAt,
            id: cursor.id,
        }),
    ).toString("base64url");
}

export function decodeRecordingCursor(cursor: string): RecordingCursor | null {
    try {
        const raw = JSON.parse(
            Buffer.from(cursor, "base64url").toString("utf8"),
        ) as unknown;
        if (!raw || typeof raw !== "object") return null;

        const payload = raw as Record<string, unknown>;
        if (
            typeof payload.updatedAt !== "string" ||
            typeof payload.id !== "string"
        ) {
            return null;
        }

        const updatedAt = payload.updatedAt;
        if (!CURSOR_TIMESTAMP.test(updatedAt) || !payload.id) return null;
        const parsed = new Date(updatedAt);
        if (
            Number.isNaN(parsed.getTime()) ||
            parsed.toISOString().slice(0, 19) !== updatedAt.slice(0, 19)
        ) {
            return null;
        }

        return { updatedAt, id: payload.id };
    } catch {
        return null;
    }
}

export function serializeTranscript(
    transcription: TranscriptionRow | null,
    corrections?: readonly OverlayCorrection[],
): V1Transcript | null {
    if (!transcription) return null;

    return {
        source: transcription.source,
        language: transcription.detectedLanguage,
        text: decryptText(transcription.text),
        provider: transcription.provider,
        model: transcription.model,
        created_at: toIso(transcription.createdAt),
        ...(corrections
            ? {
                  turns:
                      readTranscriptTurns(transcription)?.map((turn) => ({
                          speaker: turn.speaker,
                          start_ms: turn.startMs,
                          end_ms: turn.endMs,
                          text: turn.text,
                      })) ?? null,
                  corrections: corrections.map((correction) => ({
                      id: correction.id ?? "",
                      turn_index: correction.turnIndex,
                      char_start: correction.charStart,
                      char_end: correction.charEnd,
                      heard: correction.heard,
                      kind: correction.kind,
                      replacement: correction.replacement,
                      meaning: correction.meaning,
                  })),
              }
            : {}),
    };
}

export function serializeSummary(
    enhancement: AiEnhancementRow | null,
): V1Summary | null {
    if (!enhancement) return null;
    const actionItems = decryptJsonField<unknown>(enhancement.actionItems);
    const keyPoints = decryptJsonField<unknown>(enhancement.keyPoints);

    return {
        text: decryptText(enhancement.summary) ?? null,
        action_items: stringArrayOrNull(actionItems),
        key_points: stringArrayOrNull(keyPoints),
        provider: enhancement.provider,
        model: enhancement.model,
        created_at: toIso(enhancement.createdAt),
    };
}

export function serializeRecording(
    recording: RecordingRow,
    device: DeviceRow | null,
    flags: { hasTranscription: boolean; hasSummary: boolean },
): V1Recording {
    const self = `/api/v1/recordings/${recording.id}`;

    return {
        id: recording.id,
        title: decryptText(recording.title),
        created_at: toIso(recording.createdAt),
        updated_at: toIso(recording.updatedAt),
        recorded_at: toIso(recording.occurredAt),
        duration_ms: recording.duration,
        filesize_bytes: recording.filesize,
        device: device
            ? {
                  serial_number: device.serialNumber,
                  name: device.name,
                  model: device.model,
              }
            : null,
        has_transcription: flags.hasTranscription,
        has_summary: flags.hasSummary,
        audio_reaped: recording.audioReapedAt !== null,
        links: {
            self,
            transcript: `${self}/transcript`,
            audio: `${self}/audio`,
        },
    };
}

/**
 * Choose the primary transcript for singular contexts (the `transcript` field,
 * summary input, the v1 transcript endpoint). Prefers the user's configured
 * source, then their own 'riffado' transcript, then whatever exists.
 */
export function resolvePrimaryTranscript<T extends { source: string }>(
    transcripts: T[],
    preferredSource: string,
): T | null {
    if (transcripts.length === 0) return null;
    return (
        transcripts.find((t) => t.source === preferredSource) ??
        transcripts.find((t) => t.source === "riffado") ??
        transcripts[0]
    );
}

export function serializeRecordingDetail(
    recording: RecordingRow,
    device: DeviceRow | null,
    transcripts: TranscriptionRow[],
    enhancements: AiEnhancementRow[],
    preferredSource = "plaud",
): V1RecordingDetail {
    const primary = resolvePrimaryTranscript(transcripts, preferredSource);
    const primaryEnhancement =
        enhancements.find((item) => item.source === preferredSource) ??
        enhancements.find((item) => item.source === "riffado") ??
        enhancements[0] ??
        null;
    return {
        ...serializeRecording(recording, device, {
            hasTranscription: transcripts.length > 0,
            hasSummary: enhancements.length > 0,
        }),
        transcript: serializeTranscript(primary),
        transcripts: transcripts
            .map((transcript) => serializeTranscript(transcript))
            .filter((t): t is V1Transcript => t !== null),
        summary: serializeSummary(primaryEnhancement),
    };
}

/** The user's preferred primary transcript source (default 'plaud'). */
export async function getPreferredTranscriptSource(
    userId: string,
): Promise<string> {
    const [settings] = await db
        .select({ preferred: userSettings.preferredTranscriptSource })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    return settings?.preferred ?? "plaud";
}

export async function getV1RecordingDetailForUser(
    userId: string,
    recordingId: string,
): Promise<V1RecordingDetail | null> {
    const [row] = await db
        .select({
            recording: audioItemColumns,
            device: plaudDevices,
        })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .leftJoin(
            plaudDevices,
            and(
                eq(plaudDevices.userId, userId),
                eq(plaudDevices.serialNumber, recordings.deviceSn),
            ),
        )
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);

    if (!row) return null;

    const [transcriptRows, enhancementRows] = await Promise.all([
        db
            .select()
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, userId),
                ),
            ),
        db
            .select()
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, recordingId),
                    eq(aiEnhancements.userId, userId),
                ),
            ),
    ]);

    return serializeRecordingDetail(
        row.recording,
        row.device,
        transcriptRows,
        enhancementRows,
        await getPreferredTranscriptSource(userId),
    );
}
