import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({
    db: { select: vi.fn() },
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: vi.fn((value: string | null) => value),
    decryptJsonField: vi.fn((value: unknown) => value),
}));

const uploadFile = vi.fn().mockResolvedValue("stored");

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        uploadFile: (...args: unknown[]) => uploadFile(...args),
    }),
}));

import { db } from "@/db";
import {
    buildSummaryMarkdown,
    buildTranscriptMarkdown,
    exportRecordingSidecars,
    sidecarKey,
} from "@/lib/export/document-sidecars";

const RECORDED_AT = new Date("2026-09-11T18:42:00.000Z");

type QueryChain = Promise<unknown[]> & {
    from: () => QueryChain;
    where: () => QueryChain;
    limit: () => Promise<unknown[]>;
};

/** Resolves a Drizzle-style chain whether or not `.limit()` is called. */
function rows(result: unknown[]): QueryChain {
    const chain: QueryChain = Object.assign(Promise.resolve(result), {
        from: () => chain,
        where: () => chain,
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
        });

        expect(md).toBe(
            [
                "---",
                'title: "Board meeting"',
                "recorded: 2026-09-11T18:42:00.000Z",
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
        });

        expect(md).toContain('title: "Q4: \\"budget\\" review"');
        expect(md).toContain("language: null");
        expect(md).toContain("duration: 00:00:00");
    });
});

describe("buildSummaryMarkdown", () => {
    it("renders summary, key points and action items", () => {
        const md = buildSummaryMarkdown({
            title: "Board meeting",
            recordedAt: RECORDED_AT,
            provider: "OpenAI",
            model: "gpt-4o-mini",
            summary: "We agreed the budget.",
            keyPoints: ["Budget approved", "Hiring paused"],
            actionItems: ["Send the deck"],
        });

        expect(md).toContain("## Summary\n\nWe agreed the budget.");
        expect(md).toContain(
            "## Key points\n\n- Budget approved\n- Hiring paused",
        );
        expect(md).toContain("## Action items\n\n- Send the deck");
    });

    it("omits empty sections", () => {
        const md = buildSummaryMarkdown({
            title: "Standup",
            recordedAt: RECORDED_AT,
            provider: "OpenAI",
            model: "gpt-4o-mini",
            summary: "Short sync.",
            keyPoints: [],
            actionItems: [],
        });

        expect(md).toContain("## Summary");
        expect(md).not.toContain("## Key points");
        expect(md).not.toContain("## Action items");
    });
});

describe("exportRecordingSidecars", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        uploadFile.mockResolvedValue("stored");
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
                        storagePath: "user-1/Board meeting.mp3",
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
                        source: "riffado",
                        text: "Hello there.",
                        detectedLanguage: "en",
                        provider: "ElevenLabs",
                        model: "scribe_v2",
                    },
                ]) as never,
            )
            // settings (preferred transcript source)
            .mockReturnValueOnce(rows([{ preferred: "riffado" }]) as never);

        const written = await exportRecordingSidecars("user-1", "rec-1", {
            transcript: true,
            summary: false,
        });

        expect(written).toEqual(["transcript"]);
        expect(uploadFile).toHaveBeenCalledTimes(1);
        const [key, buffer, contentType] = uploadFile.mock.calls[0] as [
            string,
            Buffer,
            string,
        ];
        expect(key).toBe("user-1/Board meeting.transcript.md");
        expect(contentType).toBe("text/markdown; charset=utf-8");
        expect(buffer.toString("utf8")).toContain("Hello there.");
    });

    it("writes nothing when the recording has no transcript yet", async () => {
        vi.mocked(db.select)
            .mockReturnValueOnce(
                rows([
                    {
                        id: "rec-1",
                        userId: "user-1",
                        filename: "Board meeting",
                        storagePath: "user-1/Board meeting.mp3",
                        startTime: RECORDED_AT,
                        duration: 60_000,
                        deletedAt: null,
                    },
                ]) as never,
            )
            .mockReturnValueOnce(rows([]) as never)
            .mockReturnValueOnce(rows([{ preferred: "riffado" }]) as never);

        const written = await exportRecordingSidecars("user-1", "rec-1", {
            transcript: true,
            summary: false,
        });

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
