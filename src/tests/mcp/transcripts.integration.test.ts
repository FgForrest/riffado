/**
 * The transcript tools of the MCP server against a real PostgreSQL: which
 * transcripts a user and a service caller read, the corrections and
 * speaker names each view shows, paging and time windows of
 * `get_transcript`, and the bounded scan of `search_transcripts`.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    learnReviewItems,
    learnRuns,
    transcriptCorrections,
    transcriptions,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, audit, scanAllowed } = vi.hoisted(() => {
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
        scanAllowed: vi.fn(),
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
vi.mock("@/lib/mcp/rate-limit", () => ({ allowMcpScan: scanAllowed }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { ensureRootFolders } from "@/lib/folders/folders";
import { createEntity } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { correctionOverlay } from "@/lib/learn/llm-input";
import type { McpCaller } from "@/lib/mcp/caller";
import { McpToolError } from "@/lib/mcp/errors";
import { buildMcpServer, type McpToolDef } from "@/lib/mcp/registry";
import type { McpRole } from "@/lib/mcp/roles";
import { TRANSCRIPT_TOOLS } from "@/lib/mcp/tools/transcripts";
import { ensureOrgAccount } from "@/lib/org/account";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import {
    attributeSpeaker,
    insertPerson,
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
const LONG_TURNS = 100;
const SCAN_RECORDINGS = 205;

interface TurnOut {
    speaker: string | null;
    start_ms: number | null;
    end_ms: number | null;
    text: string;
}

interface TranscriptOut {
    recording: { id: string; title: string; recorded_at: string; url: string };
    has_transcript: boolean;
    language: string | null;
    timed: boolean;
    turns: TurnOut[];
    next_cursor: string | null;
    resolved?: { input: string; id: string; name: string; matched_by: string };
}

interface SearchOut {
    results: {
        recording: {
            id: string;
            title: string;
            recorded_at: string;
            url: string;
        };
        hits: {
            start_ms: number | null;
            speaker: string | null;
            snippet: string;
        }[];
    }[];
    scanned: number;
    complete: boolean;
    continue_before: string | null;
}

function tool(name: string): McpToolDef {
    const found = TRANSCRIPT_TOOLS.find((entry) => entry.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
}

async function getTranscript(
    caller: McpCaller,
    args: Record<string, unknown>,
    touched: string[] = [],
): Promise<TranscriptOut> {
    return (await tool("get_transcript").run(
        { caller, touched },
        args,
    )) as unknown as TranscriptOut;
}

async function search(
    caller: McpCaller,
    args: Record<string, unknown>,
    touched: string[] = [],
): Promise<SearchOut> {
    return (await tool("search_transcripts").run(
        { caller, touched },
        args,
    )) as unknown as SearchOut;
}

async function failure(promise: Promise<unknown>): Promise<McpToolError> {
    const caught = await promise.then(
        () => null,
        (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(McpToolError);
    return caught as McpToolError;
}

function turn(
    speaker: string,
    startMs: number,
    endMs: number,
    text: string,
): TranscriptTurn {
    return { speaker, startMs, endMs, text };
}

const scanId = (n: number) => `scan-${String(n).padStart(3, "0")}`;

describeWithDatabase("MCP transcript tools (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    const ref: Record<string, string> = {};

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    const alice = (roles: McpRole[] = ["transcripts:read"]) =>
        userCaller(ALICE, "alice@example.test", roles, orgUserId);
    const bob = (roles: McpRole[] = ["transcripts:read"]) =>
        userCaller(BOB, "bob@example.test", roles, orgUserId);
    const service = (roles: McpRole[] = ["transcripts:read"]) =>
        serviceCaller(orgUserId, roles);

    async function timedTranscript(
        recordingId: string,
        userId: string,
        turns: TranscriptTurn[],
        language: string,
    ): Promise<string> {
        const id = await insertTranscript(db(), recordingId, userId, {
            text: turns.map((t) => `${t.speaker}: ${t.text}`).join("\n"),
            language,
        });
        await db()
            .update(transcriptions)
            .set({ turns: encryptJsonField(turns) })
            .where(eq(transcriptions.id, id));
        return id;
    }

    function correction(
        userId: string,
        transcriptionId: string,
        turns: TranscriptTurn[],
        turnIndex: number,
        heard: string,
        replacement: string,
        targetEntityId: string,
    ) {
        const charStart = turns[turnIndex]?.text.indexOf(heard) ?? -1;
        if (charStart < 0) throw new Error(`no "${heard}" in turn`);
        return {
            userId,
            transcriptionId,
            transcriptRevision: 0,
            turnIndex,
            charStart,
            charEnd: charStart + heard.length,
            heard: encryptText(heard),
            heardHmac: domainLookupHash("correction-heard", heard),
            kind: "correct" as const,
            targetEntityId,
            replacement: encryptText(replacement),
            createdByUserId: userId,
        };
    }

    const r1Turns = [
        turn("speaker_0", 0, 4000, "Pošlete to Novákovi zítra."),
        turn("speaker_1", 5000, 9000, "Projekt Oreon jde dobře."),
        turn("speaker_0", 10_000, 12_000, "Díky, na shledanou."),
    ];
    const r3Turns = [
        turn("speaker_0", 0, 3000, "The Atlass launch moves to Friday."),
        turn("speaker_1", 3000, 6000, "I will update the plan."),
    ];
    const filler = "slovo ".repeat(166).trim().padEnd(1000, "x");
    const longTurns = Array.from({ length: LONG_TURNS }, (_, n) =>
        turn("speaker_0", n * 10_000, n * 10_000 + 9000, `${n} ${filler}`),
    );

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_transcripts",
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
        await seedCoreVocabulary();
        await ensureRootFolders(ALICE);
        await ensureRootFolders(BOB);

        await insertRecording(db(), {
            id: "r1",
            userId: ALICE,
            title: "Porada o projektu",
            startTime: new Date("2026-09-05T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r2",
            userId: BOB,
            title: "Bob private plans",
            startTime: new Date("2026-09-04T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r3",
            userId: BOB,
            title: "Weekly sync Brno",
            startTime: new Date("2026-09-03T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r4",
            userId: ALICE,
            title: "Long lecture",
            startTime: new Date("2026-09-02T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r5",
            userId: ALICE,
            title: "Not transcribed yet",
            startTime: new Date("2026-09-01T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r6",
            userId: ALICE,
            title: "Old import",
            startTime: new Date("2026-08-31T10:00:00Z"),
        });
        await shareRecording(db(), "r3", orgUserId);

        ref.alicePetra = await insertPerson(db(), ALICE, "Petra Malá");
        ref.orgJan = await insertPerson(db(), orgUserId, "Jan Novotný");
        ref.bobKarel = await insertPerson(db(), BOB, "Karel Bobek");
        ref.orion = (
            await createEntity(ALICE, { typeKey: "project", name: "Orion" })
        ).id;
        ref.atlas = (
            await createEntity(orgUserId, { typeKey: "project", name: "Atlas" })
        ).id;
        ref.roadmap = (
            await createEntity(BOB, { typeKey: "project", name: "Roadmap" })
        ).id;

        ref.t1 = await timedTranscript("r1", ALICE, r1Turns, "cs");
        await timedTranscript(
            "r2",
            BOB,
            [turn("speaker_0", 0, 3000, "Novákovi volám zítra o Oreon.")],
            "cs",
        );
        const t3 = await timedTranscript("r3", BOB, r3Turns, "en");
        await timedTranscript("r4", ALICE, longTurns, "cs");
        await insertTranscript(db(), "r6", ALICE, {
            text: "speaker_0: Ahoj všichni.\nspeaker_1: Dobrý den.",
            language: "cs",
        });

        await attributeSpeaker(db(), {
            userId: ALICE,
            transcriptionId: ref.t1,
            label: "speaker_0",
            personId: ref.alicePetra,
        });
        await attributeSpeaker(db(), {
            userId: BOB,
            transcriptionId: t3,
            label: "speaker_0",
            personId: ref.orgJan,
        });
        await attributeSpeaker(db(), {
            userId: BOB,
            transcriptionId: t3,
            label: "speaker_1",
            personId: ref.bobKarel,
        });

        await db()
            .insert(transcriptCorrections)
            .values([
                correction(
                    ALICE,
                    ref.t1,
                    r1Turns,
                    1,
                    "Oreon",
                    "Orion",
                    ref.orion,
                ),
                correction(
                    orgUserId,
                    t3,
                    r3Turns,
                    0,
                    "Atlass",
                    "Atlas",
                    ref.atlas,
                ),
                // The owner's own on a shared recording: not in effect.
                correction(BOB, t3, r3Turns, 1, "plan", "roadmap", ref.roadmap),
            ]);

        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: ALICE,
                scopeUserId: ALICE,
                itemId: "r1",
                transcriptionId: ref.t1,
                view: "private",
                actorUserId: ALICE,
                trigger: "manual",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "ready",
            })
            .returning({ id: learnRuns.id });
        const pendingStart = r1Turns[1]?.text.indexOf("dobře") ?? -1;
        await db()
            .insert(learnReviewItems)
            .values({
                runId: run?.id ?? "",
                userId: ALICE,
                kind: "correction",
                fingerprintHmac: "fp-pending",
                payload: encryptJsonField({
                    kind: "correct",
                    heard: "dobře",
                    target: { entityId: ref.orion },
                    replacement: "skvěle",
                    anchors: [
                        {
                            turnIndex: 1,
                            charStart: pendingStart,
                            charEnd: pendingStart + "dobře".length,
                        },
                    ],
                }),
                preTicked: true,
            });

        for (let n = 0; n < SCAN_RECORDINGS; n++) {
            await insertRecording(db(), {
                id: scanId(n),
                userId: ALICE,
                title: `Standup ${n}`,
                startTime: new Date(Date.UTC(2026, 5, 1, 9, n)),
            });
            await insertTranscript(db(), scanId(n), ALICE, {
                text: n === 0 ? "The zebra crossing." : "Nothing to see.",
                language: "en",
            });
        }
        knowledgeStore().invalidateAll();
        scanAllowed.mockResolvedValue(true);
    }, 180_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    describe("get_transcript", () => {
        it("reads the owner's transcript, corrected and named", async () => {
            const touched: string[] = [];
            const out = await getTranscript(
                alice(),
                { recording: "r1" },
                touched,
            );
            expect(out).toEqual({
                recording: {
                    id: "r1",
                    title: "Porada o projektu",
                    recorded_at: "2026-09-05T10:00:00.000Z",
                    url: "https://riffado.example.test/dashboard?recording=r1",
                },
                has_transcript: true,
                language: "cs",
                timed: true,
                turns: [
                    {
                        speaker: "Petra Malá",
                        start_ms: 0,
                        end_ms: 4000,
                        text: "Pošlete to Novákovi zítra.",
                    },
                    {
                        speaker: "Speaker 1",
                        start_ms: 5000,
                        end_ms: 9000,
                        text: "Projekt Orion jde dobře.",
                    },
                    {
                        speaker: "Petra Malá",
                        start_ms: 10_000,
                        end_ms: 12_000,
                        text: "Díky, na shledanou.",
                    },
                ],
                next_cursor: null,
            });
            expect(touched).toEqual(["r1"]);
        });

        it("applies confirmed corrections only, never a review not yet finished", async () => {
            const withPending = await correctionOverlay(
                {
                    id: ref.t1 ?? "",
                    userId: ALICE,
                    recordingId: "r1",
                    revision: 0,
                },
                { turns: r1Turns },
            );
            expect(withPending.map((c) => c.replacement)).toContain("skvěle");
            const out = await getTranscript(alice(), { recording: "r1" });
            expect(out.turns[1]?.text).toBe("Projekt Orion jde dobře.");
        });

        it("resolves a recording by title and echoes it", async () => {
            const out = await getTranscript(alice(), {
                recording: "porada o projektu",
            });
            expect(out.recording.id).toBe("r1");
            expect(out.resolved).toEqual({
                input: "porada o projektu",
                id: "r1",
                name: "Porada o projektu",
                matched_by: "exact",
            });
        });

        it("names Organization people alone in the Organization view", async () => {
            for (const caller of [alice(), service()]) {
                const out = await getTranscript(caller, { recording: "r3" });
                expect(out.recording.url).toBe(
                    "https://riffado.example.test/dashboard?recording=r3&view=org",
                );
                expect(out.turns.map((t) => [t.speaker, t.text])).toEqual([
                    ["Jan Novotný", "The Atlas launch moves to Friday."],
                    ["Speaker 1", "I will update the plan."],
                ]);
            }
        });

        it("shows the owner their own names and the Organization's corrections", async () => {
            const out = await getTranscript(bob(), { recording: "r3" });
            expect(out.recording.url).toBe(
                "https://riffado.example.test/dashboard?recording=r3",
            );
            expect(out.turns.map((t) => [t.speaker, t.text])).toEqual([
                ["Jan Novotný", "The Atlas launch moves to Friday."],
                ["Karel Bobek", "I will update the plan."],
            ]);
        });

        it("answers not found for another user's private recording", async () => {
            for (const [caller, recording] of [
                [alice(), "r2"],
                [alice(), "Bob private plans"],
                [service(), "r1"],
                [service(), "Porada o projektu"],
            ] as const) {
                expect(
                    await failure(getTranscript(caller, { recording })),
                ).toMatchObject({ outcome: "not_found" });
            }
        });

        it("says so when a recording has no transcript", async () => {
            const out = await getTranscript(alice(), { recording: "r5" });
            expect(out).toMatchObject({
                has_transcript: false,
                language: null,
                timed: false,
                turns: [],
                next_cursor: null,
            });
        });

        it("reads a transcript without stored turns from its text, untimed", async () => {
            const out = await getTranscript(alice(), { recording: "r6" });
            expect(out).toMatchObject({ has_transcript: true, timed: false });
            expect(out.turns).toEqual([
                {
                    speaker: "Speaker 0",
                    start_ms: null,
                    end_ms: null,
                    text: "Ahoj všichni.",
                },
                {
                    speaker: "Speaker 1",
                    start_ms: null,
                    end_ms: null,
                    text: "Dobrý den.",
                },
            ]);
            expect(
                (await getTranscript(alice(), { recording: "r6", from_ms: 0 }))
                    .turns,
            ).toEqual([]);
        });

        it("pages a long transcript at about 40,000 characters", async () => {
            const pages: TranscriptOut[] = [];
            let cursor: string | null = null;
            do {
                const page: TranscriptOut = await getTranscript(alice(), {
                    recording: "r4",
                    ...(cursor ? { cursor } : {}),
                });
                pages.push(page);
                cursor = page.next_cursor;
            } while (cursor);
            expect(pages.map((page) => page.turns.length)).toEqual([
                39, 39, 22,
            ]);
            for (const page of pages) {
                const chars = page.turns.reduce(
                    (sum, t) => sum + t.text.length,
                    0,
                );
                expect(chars).toBeLessThanOrEqual(40_000);
            }
            expect(
                pages.flatMap((page) => page.turns.map((t) => t.start_ms)),
            ).toEqual(longTurns.map((t) => t.startMs));
            expect(
                await failure(
                    getTranscript(alice(), { recording: "r4", cursor: "x" }),
                ),
            ).toMatchObject({ message: "Invalid cursor" });
        });

        it("splits a turn too long for one page, keeping its speaker", async () => {
            await insertRecording(db(), {
                id: "r-monologue",
                userId: BOB,
                title: "Monologue",
                startTime: new Date("2020-01-01T10:00:00Z"),
            });
            const text = Array.from(
                { length: 20_000 },
                (_, n) => `w${String(n).padStart(5, "0")}`,
            ).join(" ");
            expect(text.length).toBeGreaterThan(110_000);
            await insertTranscript(db(), "r-monologue", BOB, {
                text: `speaker_0: ${text}`,
                language: "en",
            });
            const pages: TranscriptOut[] = [];
            let cursor: string | null = null;
            do {
                const page: TranscriptOut = await getTranscript(bob(), {
                    recording: "r-monologue",
                    ...(cursor ? { cursor } : {}),
                });
                pages.push(page);
                cursor = page.next_cursor;
            } while (cursor && pages.length < 10);
            expect(pages.length).toBeGreaterThanOrEqual(3);
            expect(pages.at(-1)?.next_cursor).toBeNull();
            for (const page of pages) {
                const chars = page.turns.reduce(
                    (sum, t) => sum + t.text.length,
                    0,
                );
                expect(chars).toBeLessThanOrEqual(40_000);
            }
            const chunks = pages.flatMap((page) => page.turns);
            for (const chunk of chunks) {
                expect(chunk).toMatchObject({
                    speaker: "Speaker 0",
                    start_ms: null,
                    end_ms: null,
                });
                expect(chunk.text).toMatch(/^w\d{5}\b/);
            }
            expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
        });

        it("keeps to a time window", async () => {
            const out = await getTranscript(alice(), {
                recording: "r4",
                from_ms: 25_000,
                to_ms: 45_000,
            });
            expect(out.turns.map((t) => t.start_ms)).toEqual([
                20_000, 30_000, 40_000,
            ]);
            expect(out.next_cursor).toBeNull();
            const tail = await getTranscript(alice(), {
                recording: "r1",
                from_ms: 5000,
            });
            expect(tail.turns.map((t) => t.start_ms)).toEqual([5000, 10_000]);
            expect(
                await failure(
                    getTranscript(alice(), {
                        recording: "r1",
                        from_ms: 9000,
                        to_ms: 1000,
                    }),
                ),
            ).toMatchObject({ outcome: "invalid" });
        });
    });

    describe("search_transcripts", () => {
        it("finds a Czech inflected form, without accents too", async () => {
            for (const query of ["Novák", "novak"]) {
                const touched: string[] = [];
                const out = await search(alice(), { query }, touched);
                expect(out.results).toEqual([
                    {
                        recording: {
                            id: "r1",
                            title: "Porada o projektu",
                            recorded_at: "2026-09-05T10:00:00.000Z",
                            url: "https://riffado.example.test/dashboard?recording=r1",
                        },
                        hits: [
                            {
                                start_ms: 0,
                                speaker: "Petra Malá",
                                snippet: "Pošlete to Novákovi zítra.",
                            },
                        ],
                    },
                ]);
                expect(touched).toEqual(["r1"]);
            }
            expect(
                (await search(bob(), { query: "Novák" })).results.map(
                    (r) => r.recording.id,
                ),
            ).toEqual(["r2"]);
            expect(
                (await search(service(), { query: "Novák" })).results,
            ).toEqual([]);
        });

        it("searches the corrected text", async () => {
            const orion = await search(alice(), { query: "Orion" });
            expect(orion.results.map((r) => r.recording.id)).toEqual(["r1"]);
            expect(orion.results[0]?.hits[0]).toMatchObject({
                start_ms: 5000,
                speaker: "Speaker 1",
            });
            expect((await search(alice(), { query: "Oreon" })).results).toEqual(
                [],
            );
            const atlas = await search(alice(), { query: "atlas launch" });
            expect(atlas.results).toEqual([
                {
                    recording: expect.objectContaining({
                        id: "r3",
                        url: "https://riffado.example.test/dashboard?recording=r3&view=org",
                    }),
                    hits: [
                        {
                            start_ms: 0,
                            speaker: "Jan Novotný",
                            snippet: "The Atlas launch moves to Friday.",
                        },
                    ],
                },
            ]);
        });

        it("stops at its scan limit and continues where it stopped", async () => {
            const window = {
                query: "zebra",
                from: "2026-06-01",
                to: "2026-06-30",
            };
            const first = await search(alice(), window);
            expect(first).toMatchObject({
                results: [],
                scanned: 200,
                complete: false,
            });
            expect(first.continue_before).not.toBeNull();
            const second = await search(alice(), {
                ...window,
                before: first.continue_before,
            });
            expect(second).toMatchObject({
                scanned: SCAN_RECORDINGS - 200,
                complete: true,
                continue_before: null,
            });
            expect(second.results).toEqual([
                {
                    recording: expect.objectContaining({ id: scanId(0) }),
                    hits: [
                        {
                            start_ms: null,
                            speaker: null,
                            snippet: "The zebra crossing.",
                        },
                    ],
                },
            ]);
        });

        it("refuses a search over the caller's scan budget", async () => {
            scanAllowed.mockResolvedValueOnce(false);
            expect(
                await failure(search(alice(), { query: "Novák" })),
            ).toMatchObject({
                message: "Too many searches; retry in a minute",
                outcome: "denied",
            });
        });

        it("refuses a query without words", async () => {
            expect(
                await failure(search(alice(), { query: "…" })),
            ).toMatchObject({ outcome: "invalid" });
        });
    });

    describe("through the MCP server", () => {
        async function connect(caller: McpCaller): Promise<Client> {
            const server = buildMcpServer(TRANSCRIPT_TOOLS, caller, null);
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
                "get_transcript",
                "search_transcripts",
            ]);
            const searching = listed.tools.find(
                (t) => t.name === "search_transcripts",
            );
            expect(
                Object.keys(searching?.inputSchema.properties ?? {}),
            ).toEqual(["query", "from", "to", "folder", "person", "before"]);

            const transcript = (await client.callTool({
                name: "get_transcript",
                arguments: { recording: "r3" },
            })) as CallToolResult;
            expect(transcript.isError).toBeFalsy();
            expect(transcript.structuredContent).toMatchObject({
                recording: { id: "r3" },
                turns: [{ speaker: "Jan Novotný" }, { speaker: "Speaker 1" }],
            });

            const untimed = (await client.callTool({
                name: "get_transcript",
                arguments: { recording: "r6" },
            })) as CallToolResult;
            expect(untimed.isError).toBeFalsy();

            const found = (await client.callTool({
                name: "search_transcripts",
                arguments: { query: "Novák", from: "2026-09-01" },
            })) as CallToolResult;
            expect(found.isError).toBeFalsy();
            expect(found.structuredContent).toMatchObject({
                results: [{ recording: { id: "r1" } }],
                complete: true,
            });

            const hidden = (await client.callTool({
                name: "get_transcript",
                arguments: { recording: "r2" },
            })) as CallToolResult;
            expect(hidden.isError).toBe(true);
            await client.close();
        });

        it("hides the tools from a caller without transcripts:read", async () => {
            const client = await connect(alice(["summaries:read"]));
            expect((await client.listTools()).tools).toEqual([]);
            await client.close();
        });
    });
});
