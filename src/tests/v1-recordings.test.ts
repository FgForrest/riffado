import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
    },
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: vi.fn((value: string | null | undefined) =>
        typeof value === "string" ? value.replace(/^encrypted:/, "") : value,
    ),
    decryptJsonField: vi.fn((value: unknown) => value ?? null),
}));

import {
    decodeRecordingCursor,
    encodeRecordingCursor,
    serializeRecording,
    serializeRecordingDetail,
    serializeTranscript,
} from "@/lib/v1/serialize";

const now = new Date("2026-05-06T12:00:00.000Z");

const recording = {
    id: "rec-1",
    userId: "user-1",
    deviceSn: "SN-1",
    plaudFileId: "plaud-1",
    kind: "audio" as const,
    title: "encrypted:Planning Call",
    duration: 120000,
    occurredAt: new Date("2026-05-06T11:00:00.000Z"),
    endTime: new Date("2026-05-06T11:02:00.000Z"),
    filesize: 12345,
    fileMd5: "abc",
    storageType: "local",
    storagePath: "user-1/rec.mp3",
    storageFilename: null,
    downloadedAt: now,
    plaudVersion: "1",
    timezone: null,
    zonemins: null,
    scene: null,
    isTrash: false,
    waveformPeaks: null,
    deletedAt: null,
    audioReapedAt: null,
    contentReapedAt: null,
    summaryReapedAt: null,
    remoteRetentionClaimedAt: null,
    titleEditedAt: null,
    summaryDueAt: null,
    createdAt: now,
    updatedAt: now,
};

const device = {
    id: "device-1",
    userId: "user-1",
    serialNumber: "SN-1",
    name: "Plaud Note",
    model: "Note",
    versionNumber: null,
    createdAt: now,
    updatedAt: now,
};

const transcription = {
    id: "tr-1",
    recordingId: "rec-1",
    userId: "user-1",
    text: "encrypted:Hello world",
    detectedLanguage: "en",
    transcriptionType: "server",
    provider: "openai",
    model: "whisper-1",
    source: "riffado",
    turns: null,
    topics: null,
    topicsInputFingerprint: null,
    producedByUserId: null,
    revision: 0,
    audioMd5: null,
    createdAt: now,
};

const enhancement = {
    id: "sum-1",
    itemId: "rec-1",
    userId: "user-1",
    summary: "encrypted:A short summary",
    actionItems: ["Follow up"],
    keyPoints: ["Planning"],
    provider: "openai",
    model: "gpt-4o-mini",
    source: "riffado",
    transcriptionId: "tr-1",
    // Single-pass summary: multi-pass provenance is NULL.
    inputFingerprint: null,
    multiPassRounds: null,
    multiPassUsed: null,
    multiPassMerged: null,
    producedByUserId: null,
    createdAt: now,
};

describe("v1 recordings", () => {
    it("round-trips recording cursors", () => {
        const cursor = encodeRecordingCursor({
            updatedAt: "2026-05-06T12:00:00.123456Z",
            id: "rec-1",
        });
        expect(decodeRecordingCursor(cursor)).toEqual({
            updatedAt: "2026-05-06T12:00:00.123456Z",
            id: "rec-1",
        });
        expect(decodeRecordingCursor("not-base64-json")).toBeNull();
    });

    it("still reads a millisecond cursor issued before", () => {
        const legacy = Buffer.from(
            JSON.stringify({ updatedAt: now.toISOString(), id: "rec-1" }),
        ).toString("base64url");
        expect(decodeRecordingCursor(legacy)).toEqual({
            updatedAt: "2026-05-06T12:00:00.000Z",
            id: "rec-1",
        });
    });

    it.each([
        "2026-05-06",
        "2026-05-06T12:00:00.123",
        "2026-05-06T12:00:00.1234567Z",
        "2026-05-06 12:00:00Z",
        "2026-02-30T12:00:00Z",
        "2026-05-06T24:00:00Z",
        "2026-05-06T12:00:00Z'::date",
        "now",
    ])("refuses a cursor timestamp %s", (updatedAt) => {
        const cursor = Buffer.from(
            JSON.stringify({ updatedAt, id: "rec-1" }),
        ).toString("base64url");
        expect(decodeRecordingCursor(cursor)).toBeNull();
    });

    it("serializes stable list payloads", () => {
        expect(
            serializeRecording(recording, device, {
                hasTranscription: true,
                hasSummary: true,
            }),
        ).toEqual({
            id: "rec-1",
            title: "Planning Call",
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
            recorded_at: "2026-05-06T11:00:00.000Z",
            duration_ms: 120000,
            filesize_bytes: 12345,
            device: {
                serial_number: "SN-1",
                name: "Plaud Note",
                model: "Note",
            },
            has_transcription: true,
            has_summary: true,
            // Tells a client the audio link will answer 410 before it
            // spends a request finding out.
            audio_reaped: false,
            links: {
                self: "/api/v1/recordings/rec-1",
                transcript: "/api/v1/recordings/rec-1/transcript",
                audio: "/api/v1/recordings/rec-1/audio",
            },
        });
    });

    it("inlines transcript and summary for detail payloads", () => {
        const detail = serializeRecordingDetail(
            recording,
            device,
            [transcription],
            [enhancement],
        );

        expect(detail.transcript?.text).toBe("Hello world");
        expect(detail.transcript?.source).toBe("riffado");
        expect(detail.transcripts).toHaveLength(1);
        expect(detail.summary?.text).toBe("A short summary");
        expect(detail.summary?.action_items).toEqual(["Follow up"]);
        expect(detail.summary?.key_points).toEqual(["Planning"]);
    });

    it("adds a transcript's corrections beside its text, which stays as heard", () => {
        const serialized = serializeTranscript(transcription, [
            {
                id: "c-1",
                turnIndex: 0,
                charStart: 0,
                charEnd: 5,
                heard: "Hello",
                kind: "link",
                replacement: null,
                meaning: "Greeting Inc.",
            },
        ]);
        expect(serialized?.text).toBe("Hello world");
        expect(serialized?.corrections).toEqual([
            {
                id: "c-1",
                turn_index: 0,
                char_start: 0,
                char_end: 5,
                heard: "Hello",
                kind: "link",
                replacement: null,
                meaning: "Greeting Inc.",
            },
        ]);
        // Offsets point into turns, which come with them.
        expect(
            serializeTranscript(
                {
                    ...transcription,
                    turns: [
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 900,
                            text: "Hello world",
                        },
                    ],
                },
                [],
            )?.turns,
        ).toEqual([
            {
                speaker: "speaker_0",
                start_ms: 0,
                end_ms: 900,
                text: "Hello world",
            },
        ]);
        expect(serializeTranscript(transcription)).not.toHaveProperty(
            "corrections",
        );
    });

    it("keeps legacy plaintext rows readable through the same serializers", () => {
        const detail = serializeRecordingDetail(
            { ...recording, title: "Legacy Recording" },
            null,
            [{ ...transcription, text: "Legacy transcript" }],
            [],
        );

        expect(detail.title).toBe("Legacy Recording");
        expect(detail.transcript?.text).toBe("Legacy transcript");
    });
});
