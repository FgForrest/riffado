/**
 * When multi-pass actually engages, and how many provider calls it costs.
 *
 * The orchestration itself is covered in `multi-pass.test.ts` without a
 * provider. This file covers the wiring in `generateSummaryForRecording`: the
 * settings that turn it on, the separate opt-in for the auto path, and the
 * clamp that stops a stored value out of range from firing 99 passes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    aiEnhancements,
    apiCredentials,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { DEFAULT_MERGE_PROMPT } from "@/lib/summary/multi-pass";

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

/** Rows handed to `upsertEnhancement`, so provenance writes can be asserted. */
const written: Record<string, unknown>[] = [];

const tx = {
    select: () => selectChain(),
    insert: () => ({
        values: (row: Record<string, unknown>) => {
            written.push(row);
            return Promise.resolve();
        },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};

vi.mock("@/db", () => ({
    db: {
        select: () => selectChain(),
        transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
}));

type Settings = Record<string, unknown>;

function stage(settings: Settings) {
    selectResults.set(recordings, [
        [{ id: "rec-1", userId: "user-1", deletedAt: null }],
        [{ deletedAt: null }],
    ]);
    selectResults.set(transcriptions, [
        [{ recordingId: "rec-1", userId: "user-1", text: "a transcript" }],
    ]);
    selectResults.set(userSettings, [
        [{ summaryPrompt: null, aiOutputLanguage: null, ...settings }],
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
        choices: [
            {
                message: {
                    content: JSON.stringify({
                        summary: "s",
                        keyPoints: ["k"],
                        actionItems: [],
                    }),
                },
            },
        ],
    });
}

async function generate(trigger: "manual" | "auto") {
    const { generateSummaryForRecording } = await import(
        "@/lib/summary/generate-summary"
    );
    return generateSummaryForRecording("user-1", "rec-1", { trigger });
}

/** The system prompt of every completion call, in order. */
function systemPrompts(): string[] {
    return createMock.mock.calls.map(
        (call) =>
            (
                call[0] as {
                    messages: { role: string; content: string }[];
                }
            ).messages.find((m) => m.role === "system")?.content ?? "",
    );
}

describe("multi-pass gating", () => {
    beforeEach(() => {
        createMock.mockReset();
        selectResults.clear();
        written.length = 0;
    });

    it("makes exactly one call when multi-pass is off", async () => {
        stage({ summaryMultiPass: false });
        const result = await generate("manual");

        expect(createMock).toHaveBeenCalledTimes(1);
        expect(result.multiPass).toBeUndefined();
    });

    it("runs N passes plus one merge when on", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        const result = await generate("manual");

        expect(createMock).toHaveBeenCalledTimes(4);
        expect(result.multiPass).toEqual({
            roundsRequested: 3,
            passesUsed: 3,
            merged: true,
            detail: "3/3 passes + merge",
        });
        // The last call is the merge, and it carries the merge prompt rather
        // than the summary system prompt.
        expect(systemPrompts().at(-1)).toContain(
            "UNION-and-DEDUP task, NOT a re-summarization",
        );
    });

    it("stays single-pass on the auto path unless separately enabled", async () => {
        stage({
            summaryMultiPass: true,
            summaryMultiPassRounds: 3,
            summaryMultiPassAuto: false,
        });
        const result = await generate("auto");

        // A sync can fire a dozen of these; the pass count would multiply
        // every one of them.
        expect(createMock).toHaveBeenCalledTimes(1);
        expect(result.multiPass).toBeUndefined();
    });

    it("runs multi-pass on the auto path once opted in", async () => {
        stage({
            summaryMultiPass: true,
            summaryMultiPassRounds: 2,
            summaryMultiPassAuto: true,
        });
        await generate("auto");

        expect(createMock).toHaveBeenCalledTimes(3);
    });

    it("clamps a stored pass count that is out of range", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 99 });
        const result = await generate("manual");

        // 5 passes + 1 merge. A column written before the clamp existed, or
        // by hand, must not be able to fire 99 provider calls.
        expect(createMock).toHaveBeenCalledTimes(6);
        expect(result.multiPass?.roundsRequested).toBe(5);
    });

    it("persists provenance so the badge survives a reload", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        await generate("manual");

        const row = written.at(-1) as Record<string, unknown>;
        expect(row.multiPassRounds).toBe(3);
        expect(row.multiPassUsed).toBe(3);
        expect(row.multiPassMerged).toBe(true);
    });

    it("clears provenance when a multi-pass summary is regenerated single-pass", async () => {
        stage({ summaryMultiPass: false });
        await generate("manual");

        // Written as NULL, not omitted: leaving the old values in place would
        // have the row claim a provenance this summary does not have.
        const row = written.at(-1) as Record<string, unknown>;
        expect(row.multiPassRounds).toBeNull();
        expect(row.multiPassUsed).toBeNull();
        expect(row.multiPassMerged).toBeNull();
    });

    it("prefers the user's merge prompt over the built-in one", async () => {
        stage({
            summaryMultiPass: true,
            summaryMultiPassRounds: 2,
            summaryMergePrompt: "Merge them my way.",
        });
        await generate("manual");

        const mergeSystem = systemPrompts().at(-1) ?? "";
        expect(mergeSystem).toContain("Merge them my way.");
        expect(mergeSystem).not.toContain(DEFAULT_MERGE_PROMPT);
    });
});
