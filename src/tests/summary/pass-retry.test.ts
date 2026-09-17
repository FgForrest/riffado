/**
 * Retrying a single provider call.
 *
 * The job worker retries whole jobs, minutes apart. That is the wrong
 * instrument for the most common failure by far: one rate-limited call out of
 * the three a multi-pass run makes. Retrying the job would re-run every pass,
 * paying again for the ones that already succeeded, and make the user wait
 * out a job-level backoff for all of them.
 *
 * So there is a second, much shorter retry around each call. These tests pin
 * the two halves of that: it retries what a wait can fix, and it does not
 * retry what a wait cannot -- because paying three times to discover the same
 * permanent failure is strictly worse than paying once.
 */

import { APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function stage(settings: Record<string, unknown> = {}) {
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
}

function reply(content = '{"summary":"s","keyPoints":[],"actionItems":[]}') {
    return { choices: [{ message: { content } }] };
}

function providerError(status: number, code?: string) {
    return new APIError(
        status,
        code ? { code, message: code } : { message: "boom" },
        undefined,
        undefined,
    );
}

/**
 * Run generation with the backoff waits skipped.
 *
 * The retries sleep on real timers, so without this the suite would spend
 * seconds asleep proving something about arithmetic that is already tested in
 * `jobs/backoff.test.ts`.
 */
async function generate(): Promise<unknown> {
    const { generateSummaryForRecording } = await import(
        "@/lib/summary/generate-summary"
    );
    const promise = generateSummaryForRecording("user-1", "rec-1", {
        trigger: "manual",
    });
    // Settled either way; the caller decides which it expected.
    const settled = promise.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
    );
    for (let i = 0; i < 12; i += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
    }
    return settled;
}

describe("per-call retry and repair inside summary generation", () => {
    beforeEach(() => {
        createMock.mockReset();
        selectResults.clear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("retries a rate-limited pass and succeeds on the next one", async () => {
        stage();
        createMock
            .mockRejectedValueOnce(providerError(429))
            .mockResolvedValue(reply());

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(true);
        expect(createMock).toHaveBeenCalledTimes(2);
    });

    it("retries a provider outage", async () => {
        stage();
        createMock
            .mockRejectedValueOnce(providerError(503))
            .mockRejectedValueOnce(providerError(503))
            .mockResolvedValue(reply());

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(true);
        expect(createMock).toHaveBeenCalledTimes(3);
    });

    it("repairs invalid JSON through a follow-up conversation", async () => {
        stage();
        const invalid = '{"summary":"unfinished"';
        createMock
            .mockResolvedValueOnce(reply(invalid))
            .mockResolvedValueOnce(
                reply('{"summary":"repaired","keyPoints":[],"actionItems":[]}'),
            );

        const result = (await generate()) as {
            ok: boolean;
            value?: { summary: string };
        };

        expect(result.ok).toBe(true);
        expect(result.value?.summary).toBe("repaired");
        expect(createMock).toHaveBeenCalledTimes(2);

        const repairRequest = createMock.mock.calls[1]?.[0] as {
            messages: Array<{ role: string; content: string }>;
            max_tokens: number;
        };
        expect(repairRequest.messages).toHaveLength(3);
        expect(repairRequest.messages[1]).toEqual({
            role: "assistant",
            content: invalid,
        });
        expect(repairRequest.messages[2]?.content).toContain("JSON.parse");
        expect(repairRequest.messages[2]?.content).toContain("position");
        expect(JSON.stringify(repairRequest.messages)).not.toContain(
            "a transcript",
        );
        expect(repairRequest.max_tokens).toBe(3000);
    });

    it("repairs an invalid merge instead of degrading the run", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        createMock
            .mockResolvedValueOnce(reply())
            .mockResolvedValueOnce(reply())
            .mockResolvedValueOnce(reply())
            .mockResolvedValueOnce(reply('{"summary":"unfinished"'))
            .mockResolvedValueOnce(
                reply('{"summary":"merged","keyPoints":[],"actionItems":[]}'),
            );

        const result = (await generate()) as {
            ok: boolean;
            value?: {
                summary: string;
                multiPass?: { merged: boolean; passesUsed: number };
            };
        };

        expect(result.ok).toBe(true);
        expect(result.value?.summary).toBe("merged");
        expect(result.value?.multiPass).toMatchObject({
            merged: true,
            passesUsed: 3,
        });
        expect(createMock).toHaveBeenCalledTimes(5);
    });

    it("does not retry a transcript past the context window", async () => {
        stage();
        createMock.mockRejectedValue(
            providerError(400, "context_length_exceeded"),
        );

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(false);
        // One call, not three. A transcript that does not fit will not fit in
        // two seconds, and each attempt is billed.
        expect(createMock).toHaveBeenCalledTimes(1);
    });

    it("does not retry a provider that rejected the request", async () => {
        stage();
        createMock.mockRejectedValue(providerError(400));

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(false);
        expect(createMock).toHaveBeenCalledTimes(1);
    });

    it("gives up after a bounded number of attempts", async () => {
        stage();
        createMock.mockRejectedValue(providerError(429));

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(false);
        // Bounded on purpose: a provider that is genuinely down should not be
        // ground against, and the job-level retry covers the longer outage.
        expect(createMock).toHaveBeenCalledTimes(3);
    });

    it("retries each multi-pass pass on its own, not the whole run", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        let calls = 0;
        createMock.mockImplementation(async () => {
            calls += 1;
            // Exactly one pass gets rate-limited, once.
            if (calls === 2) throw providerError(429);
            return reply();
        });

        const result = (await generate()) as { ok: boolean };

        expect(result.ok).toBe(true);
        // Three passes + one retry of the unlucky one + the merge. The two
        // passes that already succeeded are not re-run, which is the entire
        // reason this retry sits here rather than at the job level.
        expect(createMock).toHaveBeenCalledTimes(5);
    });

    it("still degrades when one pass exhausts its retries", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        let started = 0;
        createMock.mockImplementation(async () => {
            started += 1;
            // The second pass to start fails every time it is tried.
            if (started % 3 === 2) throw providerError(503);
            return reply();
        });

        const result = (await generate()) as {
            ok: boolean;
            value?: { multiPass?: { passesUsed: number } };
        };

        // A pass that runs out of attempts is dropped and the rest are
        // merged, rather than failing a run that has usable output.
        expect(result.ok).toBe(true);
        expect(result.value?.multiPass?.passesUsed).toBeGreaterThanOrEqual(1);
    });
});
