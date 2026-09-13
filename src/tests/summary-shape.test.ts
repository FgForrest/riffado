/**
 * `keyPoints` / `actionItems` are typed `string[]` everywhere downstream --
 * the column, the API response, and the render path, which does
 * `point.slice(0, 32)` to build a React key.
 *
 * The parser used to accept any array: `Array.isArray(parsed.keyPoints)`.
 * Models (smaller ones especially, and OpenAI-compatible shims) answer with
 * `[{ owner, task }]` instead of `["[owner] task"]`, and those objects were
 * encrypted and stored as-is. The recording then threw
 * `point.slice is not a function` on every open, permanently, because the bad
 * shape lived in the database rather than in the response.
 *
 * These tests pin the coercion: entries reach the caller as strings, or not
 * at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    aiEnhancements,
    apiCredentials,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";

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

vi.mock("@/lib/encryption", () => ({
    decrypt: (v: string) => v,
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string) => v,
    encryptText: (v: string) => v,
    decryptJsonField: <T>(v: T) => v,
    encryptJsonField: <T>(v: T) => v,
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn(async () => undefined),
}));

// Per-table result queues keyed by the Drizzle table object, so fixtures stay
// order-independent across tables. Mirrors the harness in
// `regressions/213-summary-truncation.test.ts`.
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

/** Stage the rows one summary run consumes, then return what the model said. */
async function summarize(modelContent: string) {
    selectResults.set(recordings, [
        [{ id: "rec-1", userId: "user-1", deletedAt: null }],
        [{ deletedAt: null }],
    ]);
    selectResults.set(transcriptions, [
        [{ recordingId: "rec-1", userId: "user-1", text: "a transcript" }],
    ]);
    selectResults.set(userSettings, [
        [{ summaryPrompt: null, aiOutputLanguage: null }],
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
        choices: [{ message: { content: modelContent } }],
    });

    const { POST } = await import("@/app/api/recordings/[id]/summary/route");
    const res = await POST(
        new Request("http://localhost/api/recordings/rec-1/summary", {
            method: "POST",
            body: JSON.stringify({}),
            headers: { "Content-Type": "application/json" },
        }),
        { params: Promise.resolve({ id: "rec-1" }) },
    );

    expect(res.status).toBe(200);
    return (await res.json()) as {
        summary: string;
        keyPoints: string[];
        actionItems: string[];
    };
}

describe("summary shape coercion", () => {
    beforeEach(() => {
        createMock.mockReset();
        selectResults.clear();
    });

    it("stringifies object entries instead of storing them raw", async () => {
        const body = await summarize(
            JSON.stringify({
                summary: "s",
                keyPoints: [{ topic: "Pricing", detail: "raise prices" }],
                actionItems: [{ owner: "Roman", task: "check the model" }],
            }),
        );

        // Every entry is a string -- this is the property the render path
        // relies on, and the one `Array.isArray` never checked.
        for (const entry of [...body.keyPoints, ...body.actionItems]) {
            expect(typeof entry).toBe("string");
        }
        // The content survives rather than being silently dropped: a visibly
        // wrong entry can be regenerated, an absent one looks like "the model
        // found nothing".
        expect(body.keyPoints[0]).toContain("Pricing");
        expect(body.actionItems[0]).toContain("Roman");
    });

    it("keeps well-formed string entries verbatim and drops blank ones", async () => {
        const body = await summarize(
            JSON.stringify({
                summary: "s",
                keyPoints: ["[Pricing] raise prices", "   ", ""],
                actionItems: ["[Roman] check the model"],
            }),
        );

        expect(body.keyPoints).toEqual(["[Pricing] raise prices"]);
        expect(body.actionItems).toEqual(["[Roman] check the model"]);
    });

    it("returns empty lists when the model sends a non-array", async () => {
        const body = await summarize(
            JSON.stringify({
                summary: "s",
                keyPoints: "not a list",
                actionItems: null,
            }),
        );

        expect(body.keyPoints).toEqual([]);
        expect(body.actionItems).toEqual([]);
    });

    it("coerces scalars rather than leaking numbers into a string list", async () => {
        const body = await summarize(
            JSON.stringify({
                summary: "s",
                keyPoints: [1, true],
                actionItems: [null, "[Roman] ok"],
            }),
        );

        expect(body.keyPoints).toEqual(["1", "true"]);
        // null is dropped; the real entry survives.
        expect(body.actionItems).toEqual(["[Roman] ok"]);
    });
});
