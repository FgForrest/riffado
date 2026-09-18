import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({
    db: { select: vi.fn(), update: vi.fn() },
}));

const { enqueueExportPlansForUser } = vi.hoisted(() => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser,
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: vi.fn((value: string | null) => value),
    decryptJsonField: vi.fn((value: unknown) => value),
}));

const uploadFile = vi.fn().mockResolvedValue("stored");
const exists = vi.fn().mockResolvedValue(false);
const copyFile = vi.fn().mockResolvedValue("copied");
const deleteFile = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        uploadFile: (...args: unknown[]) => uploadFile(...args),
        exists: (...args: unknown[]) => exists(...args),
        copyFile: (...args: unknown[]) => copyFile(...args),
        deleteFile: (...args: unknown[]) => deleteFile(...args),
    }),
}));

import { db } from "@/db";
import {
    buildSummaryMarkdown,
    buildTranscriptMarkdown,
    exportRecordingSidecars,
    refreshExistingRecordingSidecars,
    sidecarKey,
} from "@/lib/export/document-sidecars";

const RECORDED_AT = new Date("2026-09-11T18:42:00.000Z");

type QueryChain = Promise<unknown[]> & {
    from: () => QueryChain;
    where: () => QueryChain;
    innerJoin: () => QueryChain;
    leftJoin: () => QueryChain;
    limit: () => Promise<unknown[]>;
};

/**
 * Resolves a Drizzle-style chain whether or not `.limit()` is called, and
 * whether or not it joins -- the speaker-name resolver reads through an
 * `innerJoin` and chains identically otherwise.
 */
function rows(result: unknown[]): QueryChain {
    const chain: QueryChain = Object.assign(Promise.resolve(result), {
        from: () => chain,
        where: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        limit: () => Promise.resolve(result),
    });
    return chain;
}

describe("sidecarKey", () => {
    it("replaces the audio extension and keeps the folder", () => {
        expect(sidecarKey("user-1/Board meeting.mp3", "transcript")).toBe(
            "user-1/Board meeting.transcript.md",
        );
        expect(sidecarKey("user-1/Board meeting.mp3", "summary")).toBe(
            "user-1/Board meeting.summary.md",
        );
    });

    it("handles keys without a folder or without an extension", () => {
        expect(sidecarKey("standup.wav", "transcript")).toBe(
            "standup.transcript.md",
        );
        expect(sidecarKey("user-1/no-extension", "summary")).toBe(
            "user-1/no-extension.summary.md",
        );
    });

    it("only strips the final extension", () => {
        expect(sidecarKey("user-1/2026-09-11.take.2.mp3", "transcript")).toBe(
            "user-1/2026-09-11.take.2.transcript.md",
        );
    });

    it("uses readable source segments for parallel variants", () => {
        expect(
            sidecarKey("user-1/Board meeting.mp3", "transcript", "riffado"),
        ).toBe("user-1/Board meeting.custom.transcript.md");
        expect(sidecarKey("user-1/Board meeting.mp3", "summary", "plaud")).toBe(
            "user-1/Board meeting.plaud.summary.md",
        );
    });
});

describe("buildTranscriptMarkdown", () => {
    it("writes front matter and the transcript body", () => {
        const md = buildTranscriptMarkdown({
            title: "Board meeting",
            recordedAt: RECORDED_AT,
            durationMs: 3_723_000,
            language: "cs",
            provider: "ElevenLabs",
            model: "scribe_v2",
            source: "riffado",
            text: "  Dobry den.  ",
            participants: ["Jana Novak", "Speaker 1"],
        });

        expect(md).toBe(
            [
                "---",
                'title: "Board meeting"',
                "recorded: 2026-09-11T18:42:00.000Z",
                "participants:",
                '  - "Jana Novak"',
                '  - "Speaker 1"',
                "duration: 01:02:03",
                'language: "cs"',
                'source: "riffado"',
                'provider: "ElevenLabs"',
                'model: "scribe_v2"',
                "---",
                "",
                "# Board meeting",
                "",
                "Dobry den.",
                "",
            ].join("\n"),
        );
    });

    it("escapes titles that would break YAML and marks unknown language", () => {
        const md = buildTranscriptMarkdown({
            title: 'Q4: "budget" review',
            recordedAt: RECORDED_AT,
            durationMs: 0,
            language: null,
            provider: "OpenAI",
            model: "whisper-1",
            source: "riffado",
            text: "x",
            participants: [],
        });

        expect(md).toContain('title: "Q4: \\"budget\\" review"');
        expect(md).toContain("language: null");
        expect(md).toContain("duration: 00:00:00");
        expect(md).toContain("participants: []");
    });
});

describe("buildSummaryMarkdown", () => {
    it("renders summary, key points and action items", () => {
        const md = buildSummaryMarkdown({
            title: "Board meeting",
            recordedAt: RECORDED_AT,
            provider: "OpenAI",
            model: "gpt-4o-mini",
            source: "riffado",
            transcriptSource: "riffado",
            summary: "We agreed the budget.",
            keyPoints: ["Budget approved", "Hiring paused"],
            actionItems: ["Send the deck"],
            participants: ["Jana Novak", "Speaker 1"],
        });

        expect(md).toContain("## Summary\n\nWe agreed the budget.");
        expect(md).toContain(
            "## Key points\n\n- Budget approved\n- Hiring paused",
        );
        expect(md).toContain("## Action items\n\n- Send the deck");
        expect(md).toContain(
            'participants:\n  - "Jana Novak"\n  - "Speaker 1"',
        );
    });

    it("omits empty sections", () => {
        const md = buildSummaryMarkdown({
            title: "Standup",
            recordedAt: RECORDED_AT,
            provider: "OpenAI",
            model: "gpt-4o-mini",
            source: "riffado",
            transcriptSource: "riffado",
            summary: "Short sync.",
            keyPoints: [],
            actionItems: [],
            participants: [],
        });

        expect(md).toContain("## Summary");
        expect(md).not.toContain("## Key points");
        expect(md).not.toContain("## Action items");
        expect(md).toContain("participants: []");
    });
});

/**
 * Queue the four reads the transcript sidecar makes: the recording, its
 * transcripts, the preferred-source setting, and the confirmed attributions.
 */
function stubTranscriptSidecar(opts: {
    text: string;
    turns?: unknown;
    attributions: { label: string; displayName: string }[];
}): void {
    vi.mocked(db.select)
        .mockReturnValueOnce(
            rows([
                {
                    id: "rec-1",
                    userId: "user-1",
                    filename: "Board meeting",
                    storagePath: "user-1/Board_meeting.mp3",
                    storageFilename: "Board_meeting.mp3",
                    startTime: RECORDED_AT,
                    duration: 60_000,
                    deletedAt: null,
                },
            ]) as never,
        )
        .mockReturnValueOnce(
            rows([
                {
                    id: "tr-1",
                    source: "riffado",
                    text: opts.text,
                    turns: opts.turns ?? null,
                    detectedLanguage: "cs",
                    provider: "Speechmatics",
                    model: "enhanced+diarize",
                },
            ]) as never,
        )
        .mockReturnValueOnce(rows([{ preferred: "riffado" }]) as never)
        .mockReturnValueOnce(rows(opts.attributions) as never);
}

describe("exportRecordingSidecars", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        uploadFile.mockResolvedValue("stored");
        exists.mockResolvedValue(false);
        copyFile.mockResolvedValue("copied");
        deleteFile.mockResolvedValue(undefined);
    });

    it("writes the transcript next to the audio file", async () => {
        vi.mocked(db.select)
            // recording
            .mockReturnValueOnce(
                rows([
                    {
                        id: "rec-1",
                        userId: "user-1",
                        filename: "Board meeting",
                        storagePath: "user-1/Board_meeting.mp3",
                        storageFilename: "Board_meeting.mp3",
                        startTime: RECORDED_AT,
                        duration: 60_000,
                        deletedAt: null,
                    },
                ]) as never,
            )
            // transcripts
            .mockReturnValueOnce(
                rows([
                    {
                        id: "tr-1",
                        source: "riffado",
                        text: "Hello there.",
                        detectedLanguage: "en",
                        provider: "ElevenLabs",
                        model: "scribe_v2",
                    },
                ]) as never,
            )
            // settings (preferred transcript source)
            .mockReturnValueOnce(rows([{ preferred: "riffado" }]) as never)
            // confirmed speaker attributions, for the name projection
            .mockReturnValueOnce(rows([]) as never);

        const written = await exportRecordingSidecars(
            "user-1",
            "rec-1",
            {
                transcript: true,
                summary: false,
            },
            "riffado",
        );

        expect(written).toEqual(["transcript"]);
        expect(uploadFile).toHaveBeenCalledTimes(1);
        const [key, buffer, contentType] = uploadFile.mock.calls[0] as [
            string,
            Buffer,
            string,
        ];
        expect(key).toBe("user-1/Board_meeting.custom.transcript.md");
        expect(contentType).toBe("text/markdown; charset=utf-8");
        expect(buffer.toString("utf8")).toContain("Hello there.");
    });

    it("names the speakers a user has confirmed", async () => {
        stubTranscriptSidecar({
            text: "speaker_0: Ahoj.\nspeaker_1: Zdravim.",
            turns: [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 1000,
                    text: "Ahoj.",
                },
                {
                    speaker: "speaker_1",
                    startMs: 1000,
                    endMs: 2000,
                    text: "Zdravim.",
                },
            ],
            attributions: [{ label: "speaker_0", displayName: "Jan" }],
        });

        await exportRecordingSidecars(
            "user-1",
            "rec-1",
            {
                transcript: true,
                summary: false,
            },
            "riffado",
        );

        const body = (uploadFile.mock.calls[0] as [string, Buffer])[1].toString(
            "utf8",
        );
        expect(body).toContain("Jan: Ahoj.");
        expect(body).not.toContain("speaker_0:");
        // The label with nobody behind it stays a label.
        expect(body).toContain("speaker_1: Zdravim.");
        expect(body).toContain('participants:\n  - "Jan"\n  - "Speaker 1"');
    });

    it("leaves the stored transcript untouched when nobody is named", async () => {
        // `buildNameResolver` filters to confirmed attributions, so a merely
        // suggested one arrives here as no rows at all. That gate is pinned
        // separately, in the projection-gate suite.
        stubTranscriptSidecar({
            text: "speaker_0: Ahoj.\nspeaker_0: Jeste jednou.",
            turns: [
                {
                    speaker: "speaker_0",
                    startMs: 0,
                    endMs: 2000,
                    text: "Ahoj. Jeste jednou.",
                },
            ],
            attributions: [],
        });

        await exportRecordingSidecars(
            "user-1",
            "rec-1",
            {
                transcript: true,
                summary: false,
            },
            "riffado",
        );

        const body = (uploadFile.mock.calls[0] as [string, Buffer])[1].toString(
            "utf8",
        );
        expect(body).toContain("speaker_0: Ahoj.\nspeaker_0: Jeste jednou.");
    });

    it("exports summary speaker references as plain attributed names", async () => {
        vi.mocked(db.select)
            .mockReturnValueOnce(
                rows([
                    {
                        id: "rec-1",
                        userId: "user-1",
                        filename: "Board meeting",
                        storagePath: "user-1/Board_meeting.mp3",
                        storageFilename: "Board_meeting.mp3",
                        startTime: RECORDED_AT,
                        duration: 60_000,
                        deletedAt: null,
                    },
                ]) as never,
            )
            .mockReturnValueOnce(
                rows([
                    {
                        source: "riffado",
                        transcriptionId: "tr-1",
                        summary: "Speaker 0 approved Speaker 1.",
                        keyPoints: ["Decision by Speaker 0"],
                        actionItems: ["Follow up with Speaker 1"],
                        provider: "OpenAI",
                        model: "gpt-4o-mini",
                    },
                ]) as never,
            )
            .mockReturnValueOnce(
                rows([
                    {
                        id: "tr-1",
                        source: "riffado",
                        text: "Speaker 0: Hello.",
                    },
                ]) as never,
            )
            .mockReturnValueOnce(rows([{ preferred: "riffado" }]) as never)
            .mockReturnValueOnce(
                rows([
                    { label: "Speaker 0", displayName: "Jane Doe" },
                ]) as never,
            );

        await exportRecordingSidecars(
            "user-1",
            "rec-1",
            {
                transcript: false,
                summary: true,
            },
            "riffado",
        );

        const body = (uploadFile.mock.calls[0] as [string, Buffer])[1].toString(
            "utf8",
        );
        expect(body).toContain("Jane Doe approved Speaker 1.");
        expect(body).toContain("Decision by Jane Doe");
        expect(body).toContain("Follow up with Speaker 1");
        expect(body).not.toContain("](#speaker-");
        expect(body).toContain('participants:\n  - "Jane Doe"');
    });

    it("schedules folder exports instead of rewriting storage sidecars", async () => {
        await refreshExistingRecordingSidecars("user-1", "rec-1");
        expect(enqueueExportPlansForUser).toHaveBeenCalledWith("user-1");
        expect(exists).not.toHaveBeenCalled();
        expect(uploadFile).not.toHaveBeenCalled();
    });

    it("moves legacy audio and sidecars to the canonical title-based name", async () => {
        exists.mockImplementation(async (key: string) =>
            key.includes("legacy"),
        );
        vi.mocked(db.select)
            .mockReturnValueOnce(
                rows([
                    {
                        id: "rec-1",
                        userId: "user-1",
                        filename: "Board meeting",
                        storagePath: "user-1/legacy.mp3",
                        storageFilename: null,
                        startTime: RECORDED_AT,
                        duration: 60_000,
                        deletedAt: null,
                    },
                ]) as never,
            )
            .mockReturnValueOnce(rows([]) as never)
            .mockReturnValueOnce(rows([]) as never)
            .mockReturnValueOnce(
                rows([
                    {
                        id: "tr-1",
                        source: "riffado",
                        text: "speaker_0: Hello.",
                        turns: [
                            {
                                speaker: "speaker_0",
                                startMs: 0,
                                endMs: 1000,
                                text: "Hello.",
                            },
                        ],
                        provider: "OpenAI",
                        model: "gpt-4o-transcribe-diarize",
                        detectedLanguage: "en",
                    },
                ]) as never,
            )
            .mockReturnValueOnce(rows([{ preferred: "riffado" }]) as never)
            .mockReturnValueOnce(rows([]) as never);
        vi.mocked(db.update).mockReturnValue({
            set: vi.fn().mockImplementation((values) => ({
                where: vi.fn().mockReturnValue({
                    returning: vi
                        .fn()
                        .mockResolvedValue([
                            "storageFilename" in values
                                ? { storageFilename: "Board_meeting.mp3" }
                                : { storagePath: "user-1/Board_meeting.mp3" },
                        ]),
                }),
            })),
        } as never);

        await exportRecordingSidecars(
            "user-1",
            "rec-1",
            {
                transcript: true,
                summary: false,
            },
            "riffado",
        );

        expect(copyFile).toHaveBeenCalledWith(
            "user-1/legacy.mp3",
            "user-1/Board_meeting.mp3",
        );
        expect(copyFile).toHaveBeenCalledWith(
            "user-1/legacy.transcript.md",
            "user-1/Board_meeting.transcript.md",
        );
        expect(copyFile).toHaveBeenCalledWith(
            "user-1/legacy.summary.md",
            "user-1/Board_meeting.summary.md",
        );
        expect(deleteFile).toHaveBeenCalledTimes(9);
        expect(uploadFile.mock.calls[0]?.[0]).toBe(
            "user-1/Board_meeting.custom.transcript.md",
        );
    });

    it("writes nothing when the recording has no transcript yet", async () => {
        vi.mocked(db.select)
            .mockReturnValueOnce(
                rows([
                    {
                        id: "rec-1",
                        userId: "user-1",
                        filename: "Board meeting",
                        storagePath: "user-1/Board_meeting.mp3",
                        storageFilename: "Board_meeting.mp3",
                        startTime: RECORDED_AT,
                        duration: 60_000,
                        deletedAt: null,
                    },
                ]) as never,
            )
            .mockReturnValueOnce(rows([]) as never)
            .mockReturnValueOnce(rows([{ preferred: "riffado" }]) as never);

        const written = await exportRecordingSidecars(
            "user-1",
            "rec-1",
            {
                transcript: true,
                summary: false,
            },
            "riffado",
        );

        expect(written).toEqual([]);
        expect(uploadFile).not.toHaveBeenCalled();
    });

    it("skips all work when neither kind is selected", async () => {
        const written = await exportRecordingSidecars("user-1", "rec-1", {
            transcript: false,
            summary: false,
        });

        expect(written).toEqual([]);
        expect(db.select).not.toHaveBeenCalled();
    });
});
