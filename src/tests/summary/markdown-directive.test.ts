/**
 * The summary the model writes is rendered as Markdown, and the instructions
 * that get it there are easy to lose.
 *
 * The system prompt used to end with "no markdown formatting or code fences".
 * That rule is about the ENVELOPE -- the reply must be a bare JSON object --
 * but models apply it to the prose inside the object too, which is why
 * summaries came back as one undifferentiated paragraph with the structure
 * inlined as "1) ... 2) ... 3)".
 *
 * These pin both halves: the envelope rule survives, and the formatting
 * permission reaches the model on the single-pass path, the multi-pass merge,
 * and a prompt the user wrote themselves (which cannot be edited to say so).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    aiEnhancements,
    apiCredentials,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import {
    SUMMARY_MARKDOWN_DIRECTIVE,
    SUMMARY_SPEAKER_DIRECTIVE,
} from "@/lib/ai/summary-presets";

vi.mock("@/lib/org/config", () => ({
    isOrgScopeVisible: () => false,
    isOrgScopeEnabled: () => false,
    getOrgUserId: async () => null,
    assertOrgScopeWritable: () => {},
    isOrgAccount: async () => false,
    assertNotOrgAccount: async () => {},
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("openai")>();
    return {
        ...actual,
        OpenAI: class {
            chat = { completions: { create: createMock } };
        },
        default: class {
            chat = { completions: { create: createMock } };
        },
    };
});

vi.mock("@/lib/encryption", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string) => v,
    encryptText: (v: string) => v,
    decryptJsonField: <T>(v: T) => v,
    encryptJsonField: <T>(v: T) => v,
}));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(async () => undefined),
}));

const selectResults = new Map<unknown, unknown[][]>();

function selectChain() {
    let table: unknown;
    const next = () => selectResults.get(table)?.shift() ?? [];
    const c = {
        from: (t: unknown) => {
            table = t;
            return c;
        },
        where: () => c,
        for: () => c,
        orderBy: () => c,
        limit: () => Promise.resolve(next()),
        // biome-ignore lint/suspicious/noThenProperty: mocks a thenable query builder
        then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(next()).then(resolve),
    };
    return c;
}

const tx = {
    select: () => selectChain(),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};

vi.mock("@/db", () => ({
    db: {
        select: () => selectChain(),
        transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
}));

const REPLY = JSON.stringify({
    summary: "## Heading\n\n- one\n- two",
    keyPoints: ["a"],
    actionItems: [],
});

interface SummarySettings {
    summaryPrompt?: unknown;
    aiOutputLanguage?: string | null;
    summaryMultiPass?: boolean;
    summaryMultiPassRounds?: number;
}

async function summarize(settings: SummarySettings = {}) {
    selectResults.set(recordings, [
        [{ id: "rec-1", userId: "user-1", deletedAt: null }],
        [{ deletedAt: null }],
    ]);
    selectResults.set(transcriptions, [
        [{ recordingId: "rec-1", userId: "user-1", text: "a transcript" }],
    ]);
    selectResults.set(userSettings, [
        [
            {
                summaryPrompt: settings.summaryPrompt ?? null,
                aiOutputLanguage: settings.aiOutputLanguage ?? null,
                summaryMultiPass: settings.summaryMultiPass ?? false,
                summaryMultiPassRounds: settings.summaryMultiPassRounds ?? null,
                summaryMergePrompt: null,
            },
        ],
    ]);
    selectResults.set(apiCredentials, [
        [
            {
                apiKey: "enc-key",
                baseUrl: "",
                provider: "openai",
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
                userId: "user-1",
            },
        ],
    ]);
    selectResults.set(aiEnhancements, [[]]);

    createMock.mockResolvedValue({
        choices: [{ message: { content: REPLY } }],
    });

    const { generateSummaryForRecording } = await import(
        "@/lib/summary/generate-summary"
    );
    return generateSummaryForRecording("user-1", "rec-1", {
        trigger: "manual",
    });
}

/** System messages from every provider call this run made. */
function systemMessages(): string[] {
    return createMock.mock.calls.map(
        (call) =>
            (call[0] as { messages: { role: string; content: string }[] })
                .messages[0].content,
    );
}

describe("markdown formatting directive", () => {
    beforeEach(() => {
        createMock.mockReset();
        selectResults.clear();
    });

    it("reaches the model on the single-pass path", async () => {
        await summarize();
        expect(systemMessages()[0]).toContain(SUMMARY_MARKDOWN_DIRECTIVE);
        expect(systemMessages()[0]).toContain(SUMMARY_SPEAKER_DIRECTIVE);
    });

    it("no longer forbids markdown outright", async () => {
        await summarize();
        // The exact wording that flattened every summary into a paragraph.
        expect(systemMessages()[0]).not.toContain("no markdown formatting");
    });

    it("forbids restating the key points inside the summary", async () => {
        // Both lists render directly beneath the summary. A summary that
        // repeats them as its own section shows everything twice, which is
        // the obvious failure mode of asking for more structure.
        await summarize();
        expect(systemMessages()[0]).toContain("rendered as their own lists");
    });

    it("caps headings at level 3, which is what the sidecar nests under", async () => {
        // `buildSummaryMarkdown` writes the summary under `## Summary`, so a
        // heading above level 3 inside it breaks the exported document's
        // hierarchy.
        await summarize();
        expect(systemMessages()[0]).toContain(
            "never open a heading above level 3",
        );
    });

    it("still demands a bare JSON object", async () => {
        await summarize();
        const system = systemMessages()[0];
        expect(system).toContain("JSON");
        expect(system).toContain("code fences");
    });

    it("reaches a prompt the user wrote themselves", async () => {
        // A custom prompt cannot be edited to mention Markdown, so the
        // directive has to be appended rather than baked into the presets.
        await summarize({
            summaryPrompt: {
                selectedPrompt: "custom-1",
                customPrompts: [
                    {
                        id: "custom-1",
                        name: "Mine",
                        prompt: "Summarize this: {transcription}",
                        createdAt: "2026-01-01T00:00:00.000Z",
                    },
                ],
            },
        });
        expect(systemMessages()[0]).toContain(SUMMARY_MARKDOWN_DIRECTIVE);
    });

    it("rides along with the language directive rather than replacing it", async () => {
        await summarize({ aiOutputLanguage: "cs" });
        const system = systemMessages()[0];
        expect(system).toContain(SUMMARY_MARKDOWN_DIRECTIVE);
        expect(system).toContain("Czech");
    });

    it("reaches the multi-pass merge, which rewrites the prose", async () => {
        await summarize({ summaryMultiPass: true, summaryMultiPassRounds: 2 });
        // Passes then merge: the merge is the last call, and it is the one
        // that would otherwise flatten the passes' Markdown.
        const messages = systemMessages();
        expect(messages.length).toBeGreaterThan(2);
        expect(messages.at(-1)).toContain(SUMMARY_MARKDOWN_DIRECTIVE);
        expect(messages.at(-1)).toContain(SUMMARY_SPEAKER_DIRECTIVE);
    });

    it("forbids guessed identities and specifies stable placeholders", async () => {
        await summarize();
        const system = systemMessages()[0];
        expect(system).toContain("Never infer, guess, or invent");
        expect(system).toContain("[Speaker N](#speaker-N)");
        expect(system).toContain("summary, keyPoints, and actionItems");
    });
});

/**
 * Every prompt is written in English, so "auto" used to mean "no language
 * instruction at all" -- and a Czech transcript came back in English, or in
 * Czech under the English "###" headings the preset named.
 */
describe("output language under auto", () => {
    beforeEach(() => {
        createMock.mockReset();
        selectResults.clear();
    });

    it("tells a pass to write in the transcription's language, headings included", async () => {
        await summarize({ aiOutputLanguage: null });
        const system = systemMessages()[0];
        expect(system).toContain(
            "the language the transcription is predominantly spoken in",
        );
        expect(system).toContain("every heading, label, and example wording");
    });

    it("treats an explicit auto the same as no preference", async () => {
        await summarize({ aiOutputLanguage: "auto" });
        expect(systemMessages()[0]).toContain(
            "the language the transcription is predominantly spoken in",
        );
    });

    it("points the merge at the passes, since it never sees the transcript", async () => {
        await summarize({ summaryMultiPass: true, summaryMultiPassRounds: 2 });
        const messages = systemMessages();
        expect(messages[0]).toContain(
            "the language the transcription is predominantly spoken in",
        );
        expect(messages.at(-1)).toContain(
            "the language the extractions are written in",
        );
    });

    it("keeps the English speaker placeholders the resolver matches on", async () => {
        await summarize();
        expect(systemMessages()[0]).toContain(
            "keep speaker references such as [Speaker 1](#speaker-1) exactly as written",
        );
    });

    it("gives way to a language the user chose", async () => {
        await summarize({
            aiOutputLanguage: "cs",
            summaryMultiPass: true,
            summaryMultiPassRounds: 2,
        });
        for (const system of systemMessages()) {
            expect(system).toContain(
                "Write all natural-language output in Czech",
            );
            expect(system).not.toContain("predominantly spoken in");
            expect(system).not.toContain("the extractions are written in");
        }
    });

    it("translates the preset's headings into a chosen language too", async () => {
        // A chosen language had the same gap as auto: "Write in Czech" alone
        // left the preset's English "### Attendees" in place, and said
        // nothing to stop [Speaker 1] from being translated out of the form
        // the resolver matches on.
        await summarize({
            aiOutputLanguage: "cs",
            summaryMultiPass: true,
            summaryMultiPassRounds: 2,
        });
        for (const system of systemMessages()) {
            expect(system).toContain(
                "every heading, label, and example wording",
            );
            expect(system).toContain(
                "keep speaker references such as [Speaker 1](#speaker-1) exactly as written",
            );
            // The escape hatch for a custom prompt naming its own language
            // belongs to auto only: a chosen language is the user's word.
            expect(system).not.toContain("Follow a different output language");
        }
    });
});

describe("markdown content survives the parser", () => {
    beforeEach(() => {
        createMock.mockReset();
        selectResults.clear();
    });

    it("keeps headings and bullets in the stored summary", async () => {
        const result = await summarize();
        expect(result.summary).toBe("## Heading\n\n- one\n- two");
    });
});
