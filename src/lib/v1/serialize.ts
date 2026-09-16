import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    plaudDevices,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";

type RecordingRow = typeof recordings.$inferSelect;
type DeviceRow = typeof plaudDevices.$inferSelect;
type TranscriptionRow = typeof transcriptions.$inferSelect;
type AiEnhancementRow = typeof aiEnhancements.$inferSelect;

export type RecordingCursor = {
    updatedAt: Date;
    id: string;
};

export type V1Transcript = {
    source: string;
    language: string | null;
    text: string;
    provider: string;
    model: string;
    created_at: string;
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

export function encodeRecordingCursor(cursor: RecordingCursor): string {
    return Buffer.from(
        JSON.stringify({
            updatedAt: toIso(cursor.updatedAt),
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

        const updatedAt = new Date(payload.updatedAt);
        if (Number.isNaN(updatedAt.getTime()) || !payload.id) return null;

        return { updatedAt, id: payload.id };
    } catch {
        return null;
    }
}

export function serializeTranscript(
    transcription: TranscriptionRow | null,
): V1Transcript | null {
    if (!transcription) return null;

    return {
        source: transcription.source,
        language: transcription.detectedLanguage,
        text: decryptText(transcription.text),
        provider: transcription.provider,
        model: transcription.model,
        created_at: toIso(transcription.createdAt),
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
        title: decryptText(recording.filename),
        created_at: toIso(recording.createdAt),
        updated_at: toIso(recording.updatedAt),
        recorded_at: toIso(recording.startTime),
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
export function resolvePrimaryTranscript(
    transcripts: TranscriptionRow[],
    preferredSource: string,
): TranscriptionRow | null {
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
            .map(serializeTranscript)
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
            recording: recordings,
            device: plaudDevices,
        })
        .from(recordings)
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
                    eq(aiEnhancements.recordingId, recordingId),
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
