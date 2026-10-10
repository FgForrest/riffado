/**
 * The summary tools of the MCP server against a real PostgreSQL: which
 * summaries a user and a service caller read, action items only with
 * `tasks:read` (in what `get_summary` returns and in what
 * `search_summaries` matches), the Learn hold, the scan's bounds and
 * `continue_before`, the scan rate limit, and one round trip through the
 * MCP server.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aiEnhancements, chatterItems, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestDatabase,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, audit, allowScan } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current) {
                    throw new Error("test database was not initialized");
                }
                const value = current[property];
                return typeof value === "function"
                    ? value.bind(current)
                    : value;
            },
        },
    );
    return {
        dbProxy: proxy,
        dbRef: ref,
        audit: vi.fn(),
        allowScan: vi.fn(async () => true),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            APP_URL: "https://riffado.example.test",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            KNOWLEDGE_MEMORY_MB: 64,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAccess: audit }));
vi.mock("@/lib/mcp/rate-limit", () => ({ allowMcpScan: allowScan }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import type { McpCaller } from "@/lib/mcp/caller";
import { McpToolError } from "@/lib/mcp/errors";
import { buildMcpServer, type McpToolDef } from "@/lib/mcp/registry";
import type { McpRole } from "@/lib/mcp/roles";
import { SUMMARY_TOOLS } from "@/lib/mcp/tools/summaries";
import { ensureOrgAccount } from "@/lib/org/account";
import { insertRecordings } from "@/tests/integration/items";
import {
    insertRecording,
    insertTranscript,
    serviceCaller,
    shareRecording,
    userCaller,
} from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";
const STANDUPS = 55;
const QUIET = 505;

interface RecordingRef {
    id: string;
    title: string;
    recorded_at: string;
    url: string;
}

interface SummaryOut {
    recording: RecordingRef;
    summary: string | null;
    key_points: string[];
    action_items?: string[];
    source: "riffado" | "plaud" | null;
    produced_at: string | null;
    resolved?: { input: string; id: string; name: string; matched_by: string };
}

interface SearchOut {
    results: { recording: RecordingRef; snippets: string[] }[];
    scanned: number;
    complete: boolean;
    continue_before: string | null;
}

async function insertSummary(
    db: TestDatabase,
    {
        recordingId,
        userId,
        summary,
        keyPoints = [],
        actionItems = [],
        source = "riffado",
    }: {
        recordingId: string;
        userId: string;
        summary: string;
        keyPoints?: string[];
        actionItems?: string[];
        source?: "riffado" | "plaud";
    },
): Promise<void> {
    await db.insert(aiEnhancements).values({
        itemId: recordingId,
        userId,
        summary: encryptText(summary),
        keyPoints: encryptJsonField(keyPoints),
        actionItems: encryptJsonField(actionItems),
        provider: "openai",
        model: "gpt-test",
        source,
        createdAt: new Date("2026-09-10T08:00:00Z"),
    });
}

function tool(name: string): McpToolDef {
    const found = SUMMARY_TOOLS.find((entry) => entry.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
}

async function getSummary(
    caller: McpCaller,
    recording: string,
    touched: string[] = [],
): Promise<SummaryOut> {
    return (await tool("get_summary").run(
        { caller, touched },
        { recording },
    )) as unknown as SummaryOut;
}

async function search(
    caller: McpCaller,
    args: Record<string, unknown>,
    touched: string[] = [],
): Promise<SearchOut> {
    return (await tool("search_summaries").run(
        { caller, touched },
        args,
    )) as unknown as SearchOut;
}

async function hitIds(
    caller: McpCaller,
    args: Record<string, unknown>,
): Promise<string[]> {
    return (await search(caller, args)).results.map((r) => r.recording.id);
}

async function failure(promise: Promise<unknown>): Promise<McpToolError> {
    const caught = await promise.then(
        () => null,
        (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(McpToolError);
    return caught as McpToolError;
}

const standupId = (n: number) => `standup-${String(n).padStart(2, "0")}`;
const quietId = (n: number) => `quiet-${String(n).padStart(3, "0")}`;

describeWithDatabase("MCP summary tools (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    const alice = (roles: McpRole[] = ["summaries:read"]) =>
        userCaller(ALICE, "alice@example.test", roles, orgUserId);
    const bob = (roles: McpRole[] = ["summaries:read"]) =>
        userCaller(BOB, "bob@example.test", roles, orgUserId);
    const service = (roles: McpRole[] = ["summaries:read"]) =>
        serviceCaller(orgUserId, roles);

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_summaries",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;

        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        if (!orgUserId) throw new Error("organization account missing");

        await insertRecording(db(), {
            id: "r1",
            userId: ALICE,
            title: "Pricing call",
            startTime: new Date("2026-09-05T10:00:00Z"),
        });
        await insertSummary(db(), {
            recordingId: "r1",
            userId: ALICE,
            summary: "We agreed the pricing for the Orion launch.",
            keyPoints: ["Discount capped at ten percent"],
            actionItems: ["Send the quarterly invoice to procurement"],
        });

        await insertRecording(db(), {
            id: "r2",
            userId: BOB,
            title: "Bob private",
            startTime: new Date("2026-09-04T10:00:00Z"),
        });
        await insertSummary(db(), {
            recordingId: "r2",
            userId: BOB,
            summary: "Secret pricing for Bob alone.",
        });

        await insertRecording(db(), {
            id: "r3",
            userId: BOB,
            title: "Weekly sync",
            startTime: new Date("2026-09-03T10:00:00Z"),
        });
        await shareRecording(db(), "r3", orgUserId);
        await insertSummary(db(), {
            recordingId: "r3",
            userId: BOB,
            summary: "The team reviewed shared pricing.",
            keyPoints: ["Hiring freeze until spring"],
        });
        await insertSummary(db(), {
            recordingId: "r3",
            userId: BOB,
            summary: "Plaud's own take on the sync.",
            source: "plaud",
        });

        await insertRecording(db(), {
            id: "r4",
            userId: ALICE,
            title: "Unsummarized",
            startTime: new Date("2026-09-02T10:00:00Z"),
        });

        await insertRecording(db(), {
            id: "r5",
            userId: ALICE,
            title: "Plaud only",
            startTime: new Date("2026-09-01T10:00:00Z"),
        });
        await insertSummary(db(), {
            recordingId: "r5",
            userId: ALICE,
            summary: "Imported from the recorder.",
            source: "plaud",
        });

        await insertRecording(db(), {
            id: "r6",
            userId: ALICE,
            title: "Schůzka",
            startTime: new Date("2026-08-30T10:00:00Z"),
        });
        await insertTranscript(db(), "r6", ALICE, { language: "cs" });
        await insertSummary(db(), {
            recordingId: "r6",
            userId: ALICE,
            summary: "Podklady jsme poslali Novákovi.",
        });

        await insertRecording(db(), {
            id: "held-summarized",
            userId: ALICE,
            title: "Held with summary",
            startTime: new Date("2026-08-29T10:00:00Z"),
        });
        await insertSummary(db(), {
            recordingId: "held-summarized",
            userId: ALICE,
            summary: "Made before the hold began.",
        });
        await insertRecording(db(), {
            id: "held-empty",
            userId: ALICE,
            title: "Held without summary",
            startTime: new Date("2026-08-28T10:00:00Z"),
        });
        await db()
            .update(chatterItems)
            .set({ summaryDueAt: new Date(Date.now() + 3_600_000) })
            .where(inArray(chatterItems.id, ["held-summarized", "held-empty"]));

        await insertRecording(db(), {
            id: "deleted",
            userId: ALICE,
            title: "Deleted pricing",
            startTime: new Date("2026-09-06T10:00:00Z"),
            deletedAt: new Date("2026-09-07T10:00:00Z"),
        });
        await insertSummary(db(), {
            recordingId: "deleted",
            userId: ALICE,
            summary: "Deleted pricing talk.",
        });

        for (let n = 0; n < STANDUPS; n++) {
            await insertRecording(db(), {
                id: standupId(n),
                userId: ALICE,
                title: `Standup ${n}`,
                startTime: new Date(Date.UTC(2025, 6, 1, 9, Math.floor(n / 3))),
            });
            await insertSummary(db(), {
                recordingId: standupId(n),
                userId: ALICE,
                summary: `Daily standup number ${n}.`,
            });
        }
        for (let n = 0; n < 5; n++) {
            await insertRecording(db(), {
                id: `standup-bare-${n}`,
                userId: ALICE,
                title: `Bare standup ${n}`,
                startTime: new Date(Date.UTC(2025, 6, 2, 9, n)),
            });
        }

        const quiet = Array.from({ length: QUIET }, (_, n) => {
            const startTime = new Date(Date.UTC(2024, 0, 1, 0, n));
            return {
                id: quietId(n),
                userId: ALICE,
                deviceSn: "SN-1",
                plaudFileId: `plaud-${quietId(n)}`,
                filename: encryptText(`Quiet ${n}`),
                duration: 60_000,
                startTime,
                endTime: new Date(startTime.getTime() + 60_000),
                filesize: 1000,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${ALICE}/${quietId(n)}.mp3`,
                plaudVersion: "1",
            };
        });
        await insertRecordings(db(), quiet);
        await db()
            .insert(aiEnhancements)
            .values(
                quiet.map((row) => ({
                    itemId: row.id,
                    userId: ALICE,
                    summary: encryptText("Nothing of note was said."),
                    keyPoints: encryptJsonField([]),
                    actionItems: encryptJsonField([]),
                    provider: "openai",
                    model: "gpt-test",
                })),
            );
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    describe("get_summary", () => {
        it("reads the caller's own summary without action items", async () => {
            const touched: string[] = [];
            const out = await getSummary(alice(), "r1", touched);
            expect(out).toEqual({
                recording: {
                    id: "r1",
                    title: "Pricing call",
                    recorded_at: "2026-09-05T10:00:00.000Z",
                    url: "https://riffado.example.test/dashboard?recording=r1",
                },
                summary: "We agreed the pricing for the Orion launch.",
                key_points: ["Discount capped at ten percent"],
                source: "riffado",
                produced_at: "2026-09-10T08:00:00.000Z",
                resolved: undefined,
            });
            expect("action_items" in out).toBe(false);
            expect(touched).toEqual(["r1"]);
        });

        it("adds action items for a caller who may read tasks", async () => {
            const out = await getSummary(
                alice(["summaries:read", "tasks:read"]),
                "r1",
            );
            expect(out.action_items).toEqual([
                "Send the quarterly invoice to procurement",
            ]);
        });

        it("resolves a recording by its title and echoes it", async () => {
            const out = await getSummary(alice(), "pricing call");
            expect(out.recording.id).toBe("r1");
            expect(out.resolved).toEqual({
                input: "pricing call",
                id: "r1",
                name: "Pricing call",
                matched_by: "exact",
            });
        });

        it("reads a shared recording's summary in the Organization view, Riffado's first", async () => {
            for (const caller of [alice(), service()]) {
                const out = await getSummary(caller, "r3");
                expect(out.summary).toBe("The team reviewed shared pricing.");
                expect(out.source).toBe("riffado");
                expect(out.recording.url).toBe(
                    "https://riffado.example.test/dashboard?recording=r3&view=org",
                );
            }
            expect((await getSummary(bob(), "r3")).recording.url).toBe(
                "https://riffado.example.test/dashboard?recording=r3",
            );
        });

        it("falls back to the Plaud summary", async () => {
            const out = await getSummary(alice(), "r5");
            expect(out).toMatchObject({
                summary: "Imported from the recorder.",
                source: "plaud",
            });
        });

        it("answers summary null for a recording without one", async () => {
            const out = await getSummary(
                alice(["summaries:read", "tasks:read"]),
                "r4",
            );
            expect(out).toMatchObject({
                summary: null,
                key_points: [],
                action_items: [],
                source: null,
                produced_at: null,
            });
        });

        it("does not read another user's private or deleted recording", async () => {
            expect(await failure(getSummary(alice(), "r2"))).toMatchObject({
                outcome: "not_found",
            });
            expect(await failure(getSummary(service(), "r2"))).toMatchObject({
                outcome: "not_found",
            });
            expect(await failure(getSummary(service(), "r1"))).toMatchObject({
                outcome: "not_found",
            });
            expect(await failure(getSummary(alice(), "deleted"))).toMatchObject(
                { outcome: "not_found" },
            );
        });

        it("shows a summary stored before a Learn hold, as the summary page does", async () => {
            expect((await getSummary(alice(), "held-summarized")).summary).toBe(
                "Made before the hold began.",
            );
            expect((await getSummary(alice(), "held-empty")).summary).toBe(
                null,
            );
        });
    });

    describe("search_summaries", () => {
        it("finds what the caller reads in summaries and key points", async () => {
            const touched: string[] = [];
            const out = await search(
                alice(),
                { query: "pricing", from: "2026-01-01" },
                touched,
            );
            expect(out.results.map((r) => r.recording.id)).toEqual([
                "r1",
                "r3",
            ]);
            expect(out.results[0]?.snippets).toEqual([
                "We agreed the pricing for the Orion launch.\nDiscount capped at ten percent",
            ]);
            expect(out.results[1]?.recording.url).toContain("&view=org");
            expect(out.complete).toBe(true);
            expect(out.continue_before).toBeNull();
            expect(touched).toEqual(["r1", "r3"]);

            expect(await hitIds(alice(), { query: "hiring freeze" })).toEqual([
                "r3",
            ]);
            expect(await hitIds(bob(), { query: "pricing" })).toEqual([
                "r2",
                "r3",
            ]);
            expect(await hitIds(service(), { query: "pricing" })).toEqual([
                "r3",
            ]);
        });

        it("matches action items only for a caller who may read tasks", async () => {
            expect(await hitIds(alice(), { query: "invoice" })).toEqual([]);
            const out = await search(alice(["summaries:read", "tasks:read"]), {
                query: "invoice",
            });
            expect(out.results.map((r) => r.recording.id)).toEqual(["r1"]);
            expect(out.results[0]?.snippets[0]).toContain(
                "Send the quarterly invoice",
            );
        });

        it("keeps snippets of other parts free of action items without tasks:read", async () => {
            const out = await search(alice(), { query: "discount" });
            expect(out.results[0]?.snippets.join(" ")).not.toContain("invoice");
        });

        it("matches word forms in the recording's language", async () => {
            expect(await hitIds(alice(), { query: "Novák" })).toEqual(["r6"]);
        });

        it("applies the recording filters", async () => {
            expect(
                await hitIds(alice(), {
                    query: "pricing",
                    from: "2026-09-04",
                }),
            ).toEqual(["r1"]);
        });

        it("stops at a page of matches and continues where it stopped", async () => {
            const window = { from: "2025-07-01", to: "2025-07-31" };
            const first = await search(alice(), {
                query: "standup",
                ...window,
            });
            expect(first.results).toHaveLength(50);
            expect(first.scanned).toBe(50);
            expect(first.complete).toBe(false);
            expect(first.continue_before).not.toBeNull();
            const second = await search(alice(), {
                query: "standup",
                ...window,
                before: first.continue_before,
            });
            expect(second.complete).toBe(true);
            expect(second.scanned).toBe(STANDUPS - 50);
            expect(
                [...first.results, ...second.results].map(
                    (r) => r.recording.id,
                ),
            ).toEqual(
                Array.from({ length: STANDUPS }, (_, n) => standupId(n))
                    .slice()
                    .reverse(),
            );
        });

        it("reads at most 500 summaries per call", async () => {
            const window = { from: "2024-01-01", to: "2024-01-31" };
            const first = await search(alice(), {
                query: "pricing",
                ...window,
            });
            expect(first).toMatchObject({
                results: [],
                scanned: 500,
                complete: false,
            });
            expect(first.continue_before).not.toBeNull();
            const second = await search(alice(), {
                query: "pricing",
                ...window,
                before: first.continue_before,
            });
            expect(second).toMatchObject({
                scanned: QUIET - 500,
                complete: true,
                continue_before: null,
            });
        });

        it("refuses a continuation it did not make", async () => {
            expect(
                await failure(
                    search(alice(), { query: "pricing", before: "nope!" }),
                ),
            ).toMatchObject({ message: "Invalid cursor" });
        });

        it("refuses a query without words", async () => {
            expect(
                await failure(search(alice(), { query: "?!" })),
            ).toMatchObject({ outcome: "invalid" });
        });

        it("is refused over the scan rate limit", async () => {
            allowScan.mockResolvedValueOnce(false);
            expect(
                await failure(search(alice(), { query: "pricing" })),
            ).toMatchObject({
                message: "Too many searches; retry in a minute",
                outcome: "denied",
            });
        });
    });

    describe("through the MCP server", () => {
        async function connect(caller: McpCaller): Promise<Client> {
            const server = buildMcpServer(SUMMARY_TOOLS, caller, null);
            const [clientSide, serverSide] =
                InMemoryTransport.createLinkedPair();
            await server.connect(serverSide);
            const client = new Client({ name: "test", version: "1" });
            await client.connect(clientSide);
            return client;
        }

        it("lists both tools and answers within their output schemas", async () => {
            const client = await connect(alice());
            const listed = await client.listTools();
            expect(listed.tools.map((t) => t.name)).toEqual([
                "get_summary",
                "search_summaries",
            ]);
            const searchListing = listed.tools.find(
                (t) => t.name === "search_summaries",
            );
            expect(
                Object.keys(searchListing?.inputSchema.properties ?? {}),
            ).toEqual(["query", "from", "to", "folder", "person", "before"]);

            const got = (await client.callTool({
                name: "get_summary",
                arguments: { recording: "r1" },
            })) as CallToolResult;
            expect(got.isError).toBeFalsy();
            expect(got.structuredContent).toMatchObject({
                recording: { id: "r1" },
                summary: "We agreed the pricing for the Orion launch.",
            });
            expect(got.structuredContent).not.toHaveProperty("action_items");

            const empty = (await client.callTool({
                name: "get_summary",
                arguments: { recording: "r4" },
            })) as CallToolResult;
            expect(empty.isError).toBeFalsy();
            expect(empty.structuredContent).toMatchObject({ summary: null });

            const found = (await client.callTool({
                name: "search_summaries",
                arguments: { query: "pricing", from: "2026-01-01" },
            })) as CallToolResult;
            expect(found.isError).toBeFalsy();
            expect(found.structuredContent).toMatchObject({
                results: [
                    { recording: { id: "r1" } },
                    { recording: { id: "r3" } },
                ],
                complete: true,
                continue_before: null,
            });

            const hidden = (await client.callTool({
                name: "get_summary",
                arguments: { recording: "r2" },
            })) as CallToolResult;
            expect(hidden.isError).toBe(true);
            await client.close();
        });

        it("returns action items through the server with tasks:read", async () => {
            const client = await connect(
                alice(["summaries:read", "tasks:read"]),
            );
            const got = (await client.callTool({
                name: "get_summary",
                arguments: { recording: "r1" },
            })) as CallToolResult;
            expect(got.structuredContent).toMatchObject({
                action_items: ["Send the quarterly invoice to procurement"],
            });
            await client.close();
        });

        it("hides the tools from a caller without summaries:read", async () => {
            const client = await connect(alice(["transcripts:read"]));
            expect((await client.listTools()).tools).toEqual([]);
            await client.close();
        });
    });
});
