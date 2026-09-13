/**
 * `POST /api/recordings/[id]/summary` — the streaming branch.
 *
 * Two properties matter. The JSON response stays the default, because the
 * auto-summarize path and every existing caller depend on it. And once the
 * stream opens the status is already 200, so a failure has to arrive as an
 * event; a client that trusts `response.ok` would otherwise read a crash as
 * a success.
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
    createStreamEventParser,
    type SummaryStreamEvent,
} from "@/lib/summary/progress-stream";

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

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
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

function stage(settings: Record<string, unknown>) {
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

function okReply() {
    return {
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
    };
}

async function post(accept?: string) {
    const { POST } = await import("@/app/api/recordings/[id]/summary/route");
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (accept) headers.Accept = accept;
    return POST(
        new Request("http://localhost/api/recordings/rec-1/summary", {
            method: "POST",
            body: JSON.stringify({}),
            headers,
        }),
        { params: Promise.resolve({ id: "rec-1" }) },
    );
}

async function readEvents(res: Response): Promise<SummaryStreamEvent[]> {
    const parse = createStreamEventParser();
    return parse(await res.text());
}

describe("POST /api/recordings/[id]/summary — streaming", () => {
    beforeEach(() => {
        createMock.mockReset();
        selectResults.clear();
    });

    it("answers with JSON when the caller does not ask for a stream", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        createMock.mockResolvedValue(okReply());

        const res = await post();

        // The auto-summarize path and the existing API tests depend on this.
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.summary).toBe("s");
    });

    it("streams a progress event per pass, then the result", async () => {
        stage({ summaryMultiPass: true, summaryMultiPassRounds: 3 });
        createMock.mockResolvedValue(okReply());

        const res = await post("text/event-stream");
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        // A proxy that buffers the stream would deliver every event at once,
        // after the work they describe had already finished.
        expect(res.headers.get("cache-control")).toContain("no-transform");

        const events = await readEvents(res);
        const progress = events.filter((e) => e.type === "progress");
        const results = events.filter((e) => e.type === "result");

        expect(progress.length).toBeGreaterThanOrEqual(4); // 0..3 passes
        expect(progress.at(-1)).toMatchObject({ phase: "merging" });
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            type: "result",
            result: { summary: "s" },
        });
    });

    it("streams no progress for a single-pass run, just the result", async () => {
        stage({ summaryMultiPass: false });
        createMock.mockResolvedValue(okReply());

        const events = await readEvents(await post("text/event-stream"));

        expect(events.filter((e) => e.type === "progress")).toHaveLength(0);
        expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    });

    it("reports a failure as an event, since the status is already 200", async () => {
        stage({ summaryMultiPass: false });
        createMock.mockRejectedValue(new Error("provider exploded"));

        const res = await post("text/event-stream");
        // Not a 500: the headers went out before anything could fail.
        expect(res.status).toBe(200);

        const events = await readEvents(res);
        expect(events.filter((e) => e.type === "result")).toHaveLength(0);
        expect(events.at(-1)).toMatchObject({ type: "error" });
    });
});
