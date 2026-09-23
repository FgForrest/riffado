/**
 * Detecting topics end to end, with the provider and the database stubbed.
 *
 * What matters: the model is shown times and its answer is snapped back to
 * them; a transcript without timings is refused before anything is paid for;
 * and topics are written only onto the transcript they were read from.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    apiCredentials,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { ErrorCode } from "@/lib/errors";

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
    };
});

vi.mock("@/lib/encryption", () => ({ decrypt: (v: string) => v }));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string) => v,
    decryptJsonField: <T>(v: T) => v,
    encryptJsonField: <T>(v: T) => ({ encrypted: v }),
}));

const selectResults = new Map<unknown, unknown[][]>();
const writes: { set: Record<string, unknown> }[] = [];
let writeMatches = true;

function selectChain() {
    let table: unknown;
    const next = () => selectResults.get(table)?.shift() ?? [];
    const c = {
        from: (t: unknown) => {
            table = t;
            return c;
        },
        where: () => c,
        limit: () => Promise.resolve(next()),
        // biome-ignore lint/suspicious/noThenProperty: mocks a thenable query builder
        then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(next()).then(resolve),
    };
    return c;
}

vi.mock("@/db", () => ({
    db: {
        select: () => selectChain(),
        update: () => ({
            set: (set: Record<string, unknown>) => ({
                where: () => ({
                    returning: async () => {
                        writes.push({ set });
                        return writeMatches ? [{ id: "tr-1" }] : [];
                    },
                }),
            }),
        }),
    },
}));

import { generateTopicsForTranscript } from "@/lib/topics/generate-topics";

const TURNS = [
    {
        speaker: "speaker_0",
        startMs: 18_000,
        endMs: 60_000,
        text: "Objednala jsem jízdenku.",
    },
    {
        speaker: "speaker_1",
        startMs: 67_000,
        endMs: 200_000,
        text: "A datum bylo špatně.",
    },
    {
        speaker: "speaker_0",
        startMs: 222_000,
        endMs: 300_000,
        text: "Pak přišla kontrola.",
    },
];

function stage(turns: unknown = TURNS) {
    selectResults.set(recordings, [[{ id: "rec-1" }]]);
    selectResults.set(transcriptions, [
        [{ id: "tr-1", text: "ciphertext", turns }],
    ]);
    selectResults.set(userSettings, [
        [{ topicPrompt: null, aiOutputLanguage: null }],
    ]);
    selectResults.set(apiCredentials, [
        [
            {
                apiKey: "key",
                baseUrl: "",
                provider: "openai",
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            },
        ],
    ]);
}

function reply(content: string) {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content } }] });
}

const run = () =>
    generateTopicsForTranscript("user-1", "rec-1", "plaud", {
        trigger: "manual",
    });

describe("generateTopicsForTranscript", () => {
    beforeEach(() => {
        selectResults.clear();
        writes.length = 0;
        writeMatches = true;
    });
    afterEach(() => {
        createMock.mockReset();
    });

    it("shows the model timed lines and stores its topics snapped to them", async () => {
        stage();
        reply(
            JSON.stringify({
                topics: [
                    { start: "00:18", title: "Objednání jízdenky" },
                    // Misquoted by a few seconds.
                    { start: "01:09", title: "Špatné datum" },
                    { start: "03:42", title: "Kontrola ve vlaku" },
                ],
            }),
        );

        const result = await run();

        const [{ messages }] = createMock.mock.calls[0];
        expect(messages[0].content).toContain('"start" must be copied exactly');
        expect(messages[1].content).toContain(
            "[00:18] Speaker 0: Objednala jsem jízdenku.",
        );
        expect(messages[1].content).toContain("[01:07] Speaker 1:");

        expect(result.topics).toEqual([
            { title: "Objednání jízdenky", fromMs: 18_000, toMs: 67_000 },
            { title: "Špatné datum", fromMs: 67_000, toMs: 222_000 },
            { title: "Kontrola ve vlaku", fromMs: 222_000, toMs: 300_000 },
        ]);
        expect(writes).toHaveLength(1);
        expect(writes[0].set.topics).toMatchObject({
            encrypted: { topics: result.topics, templateId: "default" },
        });
    });

    it("refuses a transcript without timings before calling the provider", async () => {
        stage(null);
        await expect(run()).rejects.toMatchObject({
            code: ErrorCode.INVALID_INPUT,
        });
        expect(createMock).not.toHaveBeenCalled();
        expect(writes).toHaveLength(0);
    });

    it("fails, writing nothing, when the reply holds no usable topics", async () => {
        stage();
        reply("I could not find any topics.");
        await expect(run()).rejects.toMatchObject({
            code: ErrorCode.AI_PROVIDER_API_ERROR,
        });
        expect(writes).toHaveLength(0);
    });

    it("reports a conflict when the transcript changed meanwhile", async () => {
        stage();
        reply(JSON.stringify({ topics: [{ start: "00:18", title: "A" }] }));
        writeMatches = false;
        await expect(run()).rejects.toMatchObject({
            code: ErrorCode.CONFLICT,
        });
    });

    it("splits a long transcript into windows and joins their topics", async () => {
        const long = Array.from({ length: 120 }, (_, i) => ({
            speaker: `speaker_${i % 2}`,
            startMs: i * 30_000,
            endMs: i * 30_000 + 29_000,
            text: "slovo ".repeat(100).trim(),
        }));
        stage(long);
        createMock.mockImplementation(async ({ messages }) => {
            // Name a topic at the first line of every window.
            const first = /\[(\d+:\d{2}(?::\d{2})?)\]/.exec(
                messages[1].content,
            )?.[1];
            return {
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                topics: [
                                    { start: first, title: `Od ${first}` },
                                ],
                            }),
                        },
                    },
                ],
            };
        });

        const result = await run();

        expect(result.windows).toBeGreaterThan(1);
        expect(createMock).toHaveBeenCalledTimes(result.windows);
        // Only the first window's opening topic survives: every later window
        // opens inside the previous one's overlap, which is not its to decide.
        expect(result.topics.map((topic) => topic.fromMs)).toEqual([0]);
    });
});
