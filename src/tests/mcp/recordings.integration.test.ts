/**
 * The recording tools of the MCP server against a real PostgreSQL: which
 * recordings and folders a user and a service caller see, every filter of
 * `list_recordings` (dates, folders with their subfolders and the Private
 * root, speakers, mentioned things, title words), keyset paging, and one
 * round trip through the MCP server.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    knowledgeFactEvidence,
    knowledgeFacts,
    recordingFolderAssignments,
    recordingFolders,
    transcriptCorrections,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
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

import { encryptText } from "@/lib/encryption/fields";
import { ensureRootFolders } from "@/lib/folders/folders";
import { createEntity } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { domainLookupHash, lookupHash } from "@/lib/knowledge/lookup-hash";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import type { McpCaller } from "@/lib/mcp/caller";
import { McpToolError } from "@/lib/mcp/errors";
import { buildMcpServer, type McpToolDef } from "@/lib/mcp/registry";
import type { McpRole } from "@/lib/mcp/roles";
import { RECORDING_TOOLS } from "@/lib/mcp/tools/recordings";
import { ensureOrgAccount } from "@/lib/org/account";
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
const JULY = 55;

interface RecordingOut {
    id: string;
    title: string;
    recorded_at: string;
    duration_ms: number;
    view: "private" | "org";
    owner_is_me: boolean;
    speakers: string[];
    url: string;
}

interface ListOut {
    recordings: RecordingOut[];
    next_cursor: string | null;
    scanned?: number;
    complete?: boolean;
    continue_before?: string | null;
    resolved?: {
        input: string;
        id: string;
        name: string;
        matched_by: string;
    }[];
}

interface FolderOut {
    id: string;
    parent_id: string | null;
    name: string;
    kind: string;
    scope: string;
}

function tool(name: string): McpToolDef {
    const found = RECORDING_TOOLS.find((entry) => entry.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
}

async function listRecordings(
    caller: McpCaller,
    args: Record<string, unknown> = {},
    touched: string[] = [],
): Promise<ListOut> {
    return (await tool("list_recordings").run(
        { caller, touched },
        args,
    )) as unknown as ListOut;
}

async function ids(
    caller: McpCaller,
    args: Record<string, unknown> = {},
): Promise<string[]> {
    return (await listRecordings(caller, args)).recordings.map((r) => r.id);
}

async function failure(promise: Promise<unknown>): Promise<McpToolError> {
    const caught = await promise.then(
        () => null,
        (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(McpToolError);
    return caught as McpToolError;
}

const julyId = (n: number) => `july-${String(n).padStart(2, "0")}`;

describeWithDatabase("MCP recording tools (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    const ref: Record<string, string> = {};

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    const alice = (roles: McpRole[] = ["transcripts:read"]) =>
        userCaller(ALICE, "alice@example.test", roles, orgUserId);
    const bob = (roles: McpRole[] = ["summaries:read"]) =>
        userCaller(BOB, "bob@example.test", roles, orgUserId);
    const service = (roles: McpRole[] = ["tasks:read"]) =>
        serviceCaller(orgUserId, roles);

    async function folder(
        userId: string,
        parentId: string,
        name: string,
    ): Promise<string> {
        const [row] = await db()
            .insert(recordingFolders)
            .values({
                userId,
                parentId,
                name: encryptText(name),
                nameHash: lookupHash(name),
                kind: "custom",
            })
            .returning({ id: recordingFolders.id });
        if (!row) throw new Error("folder not inserted");
        return row.id;
    }

    async function root(userId: string): Promise<string> {
        const [row] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, userId),
                    isNull(recordingFolders.parentId),
                ),
            )
            .limit(1);
        if (!row) throw new Error("root missing");
        return row.id;
    }

    async function file(
        recordingId: string,
        userId: string,
        folderId: string,
    ): Promise<void> {
        await db()
            .insert(recordingFolderAssignments)
            .values({ userId, itemId: recordingId, folderId });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_recordings",
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
            title: "Pricing call",
            startTime: new Date("2026-09-05T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r2",
            userId: BOB,
            title: "Pricing secret",
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
            title: "Schůzka o rozpočtu",
            startTime: new Date("2026-09-02T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r5",
            userId: ALICE,
            title: "Deleted pricing",
            startTime: new Date("2026-09-06T10:00:00Z"),
            deletedAt: new Date("2026-09-07T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r8",
            userId: BOB,
            title: "All hands",
            startTime: new Date("2026-09-01T10:00:00Z"),
        });
        for (let n = 0; n < JULY; n++) {
            await insertRecording(db(), {
                id: julyId(n),
                userId: ALICE,
                title: `Standup ${n}`,
                // Three to a minute: equal times, ordered by id.
                startTime: new Date(Date.UTC(2026, 6, 1, 9, Math.floor(n / 3))),
            });
        }

        const orgRoot = await root(orgUserId);
        ref.orgRoot = orgRoot;
        ref.sales = await folder(orgUserId, orgRoot, "Sales");
        ref.deals = await folder(orgUserId, ref.sales, "Deals");
        ref.alicePrivate = await root(ALICE);
        ref.projects = await folder(ALICE, ref.alicePrivate, "Projects");
        await file("r3", BOB, ref.deals);
        await shareRecording(db(), "r8", orgUserId);
        await file("r4", ALICE, ref.projects);

        ref.orgJan = await insertPerson(db(), orgUserId, "Jan Novotný");
        ref.orgEva = await insertPerson(db(), orgUserId, "Eva Dvořáková");
        ref.alicePetra = await insertPerson(db(), ALICE, "Petra Malá");
        ref.bobKarel = await insertPerson(db(), BOB, "Karel Bobek");
        ref.orion = (
            await createEntity(ALICE, { typeKey: "project", name: "Orion" })
        ).id;
        ref.atlas = (
            await createEntity(orgUserId, { typeKey: "project", name: "Atlas" })
        ).id;

        const t1 = await insertTranscript(db(), "r1", ALICE);
        const t2 = await insertTranscript(db(), "r2", BOB);
        const t3 = await insertTranscript(db(), "r3", BOB);
        const t4 = await insertTranscript(db(), "r4", ALICE);
        const t8 = await insertTranscript(db(), "r8", BOB);
        await attributeSpeaker(db(), {
            userId: ALICE,
            transcriptionId: t1,
            label: "speaker_0",
            personId: ref.alicePetra,
        });
        await attributeSpeaker(db(), {
            userId: ALICE,
            transcriptionId: t1,
            label: "speaker_1",
            personId: ref.orgEva,
            status: "suggested",
        });
        await attributeSpeaker(db(), {
            userId: BOB,
            transcriptionId: t2,
            label: "speaker_0",
            personId: ref.orgJan,
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

        const link = (
            userId: string,
            transcriptionId: string,
            targetEntityId: string,
        ) => ({
            userId,
            transcriptionId,
            transcriptRevision: 0,
            turnIndex: 0,
            charStart: 0,
            charEnd: 5,
            heard: encryptText("atlas"),
            heardHmac: domainLookupHash("correction-heard", "atlas"),
            kind: "link" as const,
            targetEntityId,
        });
        await db()
            .insert(transcriptCorrections)
            .values([
                // The Organization's, on a shared recording: in effect.
                link(orgUserId, t3, ref.atlas),
                // The owner's own, on a shared recording: not in effect.
                link(BOB, t8, ref.atlas),
                // On a private recording nobody else reads.
                link(BOB, t2, ref.atlas),
            ]);

        const [fact] = await db()
            .insert(knowledgeFacts)
            .values({
                userId: ALICE,
                subjectPersonId: ref.alicePetra,
                relationKey: "works_on",
                objectEntityId: ref.orion,
                subjectKey: `p:${ref.alicePetra}`,
                objectKey: `e:${ref.orion}`,
                origin: "recording",
            })
            .returning({ id: knowledgeFacts.id });
        if (!fact) throw new Error("fact not inserted");
        const evidence = (
            transcriptionId: string,
            recordingId: string,
            status: "supported" | "wording_changed",
        ) => ({
            userId: ALICE,
            factId: fact.id,
            transcriptionId,
            itemId: recordingId,
            transcriptRevision: 0,
            startMs: 0,
            endMs: 1000,
            quote: encryptText("Petra works on Orion"),
            status,
        });
        await db()
            .insert(knowledgeFactEvidence)
            .values([
                evidence(t4, "r4", "supported"),
                evidence(t1, "r1", "wording_changed"),
            ]);
        knowledgeStore().invalidateAll();
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    const allJuly = Array.from({ length: JULY }, (_, n) => julyId(n));

    describe("visibility", () => {
        it("shows a user their own and the shared recordings, newest first", async () => {
            const page = await listRecordings(alice(), {
                from: "2026-08-01",
            });
            expect(page.recordings.map((r) => r.id)).toEqual([
                "r1",
                "r3",
                "r4",
                "r8",
            ]);
            expect(page.next_cursor).toBeNull();
            expect(page.scanned).toBeUndefined();
            const [r1, r3] = page.recordings;
            expect(r1).toEqual({
                id: "r1",
                title: "Pricing call",
                recorded_at: "2026-09-05T10:00:00.000Z",
                duration_ms: 60_000,
                view: "private",
                owner_is_me: true,
                speakers: ["Petra Malá"],
                url: "https://riffado.example.test/dashboard?recording=r1",
            });
            expect(r3).toMatchObject({
                id: "r3",
                view: "org",
                owner_is_me: false,
                speakers: ["Jan Novotný"],
                url: "https://riffado.example.test/dashboard?recording=r3&view=org",
            });
        });

        it("never shows another user's private or a deleted recording", async () => {
            const all = [
                ...(await ids(alice(), { from: "2026-08-01" })),
                ...(await ids(alice(), { title: "pricing" })),
                ...(await ids(alice(), { person: "Jan Novotný" })),
            ];
            expect(all).not.toContain("r2");
            expect(all).not.toContain("r5");
        });

        it("names an owner's private speakers to the owner alone", async () => {
            const page = await listRecordings(bob(), {});
            expect(page.recordings.map((r) => r.id)).toEqual([
                "r2",
                "r3",
                "r8",
            ]);
            expect(page.recordings[1]).toMatchObject({
                id: "r3",
                view: "private",
                owner_is_me: true,
                speakers: ["Jan Novotný", "Karel Bobek"],
            });
        });

        it("shows a service caller the shared recordings alone", async () => {
            const page = await listRecordings(service(), {});
            expect(page.recordings.map((r) => r.id)).toEqual(["r3", "r8"]);
            expect(page.recordings[0]).toMatchObject({
                view: "org",
                owner_is_me: false,
                speakers: ["Jan Novotný"],
            });
        });

        it("logs the recordings it returned", async () => {
            const touched: string[] = [];
            const page = await listRecordings(service(), {}, touched);
            expect(touched).toEqual(page.recordings.map((r) => r.id));
        });
    });

    describe("dates", () => {
        it("keeps to the range, a date alone covering its whole day", async () => {
            expect(
                await ids(alice(), { from: "2026-09-02", to: "2026-09-03" }),
            ).toEqual(["r3", "r4"]);
            expect(
                await ids(alice(), {
                    from: "2026-09-02T10:00:00Z",
                    to: "2026-09-03T09:59:59Z",
                }),
            ).toEqual(["r4"]);
            expect(
                await ids(alice(), { from: "2026-09-03T12:00:00+02:00" }),
            ).toEqual(["r1", "r3"]);
        });

        it("refuses dates that are not ISO 8601 or out of order", async () => {
            for (const args of [
                { from: "yesterday" },
                { to: "2026-02-31" },
                { from: "09/01/2026" },
                { from: "2026-09-05", to: "2026-09-01" },
            ]) {
                expect(
                    await failure(listRecordings(alice(), args)),
                ).toMatchObject({ outcome: "invalid" });
            }
        });
    });

    describe("folders", () => {
        it("lists a user's Private tree and the Organization's", async () => {
            const result = (await tool("list_folders").run(
                { caller: alice(), touched: [] },
                {},
            )) as unknown as { folders: FolderOut[] };
            const byId = new Map(result.folders.map((f) => [f.id, f]));
            expect(byId.get(ref.alicePrivate ?? "")).toMatchObject({
                parent_id: null,
                kind: "private",
                scope: "personal",
            });
            expect(byId.get(ref.projects ?? "")).toMatchObject({
                parent_id: ref.alicePrivate,
                name: "Projects",
                scope: "personal",
            });
            expect(byId.get(ref.deals ?? "")).toMatchObject({
                parent_id: ref.sales,
                name: "Deals",
                kind: "custom",
                scope: "org",
            });
            expect(byId.get(ref.orgRoot ?? "")).toMatchObject({
                kind: "public",
                scope: "org",
            });
            expect(result.folders[0]?.scope).toBe("personal");
        });

        it("lists the Organization tree alone to a service caller", async () => {
            const result = (await tool("list_folders").run(
                { caller: service(), touched: [] },
                {},
            )) as unknown as { folders: FolderOut[] };
            expect(result.folders.map((f) => f.id).sort()).toEqual(
                [ref.orgRoot, ref.sales, ref.deals].sort(),
            );
        });

        it("includes recordings filed in subfolders", async () => {
            expect(await ids(alice(), { folder: ref.sales })).toEqual(["r3"]);
            expect(await ids(alice(), { folder: ref.deals })).toEqual(["r3"]);
            expect(await ids(alice(), { folder: ref.orgRoot })).toEqual([
                "r3",
                "r8",
            ]);
            expect(await ids(service(), { folder: ref.sales })).toEqual(["r3"]);
        });

        it("holds every own recording in the Private root", async () => {
            expect(await ids(alice(), { folder: ref.alicePrivate })).toEqual([
                "r1",
                "r4",
                ...allJuly.slice().reverse().slice(0, 48),
            ]);
            expect(await ids(alice(), { folder: ref.projects })).toEqual([
                "r4",
            ]);
        });

        it("refuses a folder outside the caller's tree", async () => {
            for (const [caller, folderId] of [
                [service(), ref.alicePrivate],
                [bob(), ref.projects],
                [alice(), "no-such-folder"],
            ] as const) {
                expect(
                    await failure(listRecordings(caller, { folder: folderId })),
                ).toMatchObject({ outcome: "not_found" });
            }
        });
    });

    describe("people and things", () => {
        it("keeps to recordings a person was confirmed speaking in", async () => {
            const page = await listRecordings(alice(), {
                person: "jan novotny",
            });
            expect(page.recordings.map((r) => r.id)).toEqual(["r3"]);
            expect(page.resolved).toEqual([
                {
                    input: "jan novotny",
                    id: ref.orgJan,
                    name: "Jan Novotný",
                    matched_by: "exact",
                },
            ]);
            expect(await ids(alice(), { person: ref.alicePetra })).toEqual([
                "r1",
            ]);
            expect(await ids(service(), { person: "Jan Novotný" })).toEqual([
                "r3",
            ]);
            expect(
                await failure(
                    listRecordings(alice(), { person: "Eva Dvořáková" }),
                ),
            ).toMatchObject({ outcome: "not_found" });
        });

        it("finds a thing through a correction in effect", async () => {
            const reader = alice(["transcripts:read", "knowledge:read"]);
            expect(await ids(reader, { entity: "Atlas" })).toEqual(["r3"]);
            expect(
                await ids(service(["tasks:read", "knowledge:read"]), {
                    entity: ref.atlas,
                }),
            ).toEqual(["r3"]);
        });

        it("finds a thing through supported fact evidence", async () => {
            const reader = alice(["transcripts:read", "knowledge:read"]);
            expect(await ids(reader, { entity: "Orion" })).toEqual(["r4"]);
            expect(
                await failure(
                    listRecordings(service(["tasks:read", "knowledge:read"]), {
                        entity: "Orion",
                    }),
                ),
            ).toMatchObject({ outcome: "not_found" });
        });

        it("has no entity filter without knowledge:read", async () => {
            const listing = tool("list_recordings");
            expect(Object.keys(listing.input(alice()))).not.toContain("entity");
            expect(
                Object.keys(
                    listing.input(
                        alice(["transcripts:read", "knowledge:read"]),
                    ),
                ),
            ).toContain("entity");
            expect(
                await ids(alice(), { from: "2026-08-01", entity: "Atlas" }),
            ).toEqual(["r1", "r3", "r4", "r8"]);
        });
    });

    describe("titles", () => {
        it("finds title words in any case, with or without accents", async () => {
            for (const title of [
                "schuzka",
                "SCHŮZKA rozpočtu",
                "Schůzka o rozpočtu",
            ]) {
                const page = await listRecordings(alice(), { title });
                expect(page.recordings.map((r) => r.id)).toEqual(["r4"]);
                expect(page.complete).toBe(true);
                expect(page.continue_before).toBeNull();
                expect(page.scanned).toBe(JULY + 4);
            }
            expect(await ids(alice(), { title: "pricing" })).toEqual(["r1"]);
            expect(await ids(service(), { title: "pricing" })).toEqual([]);
        });

        it("combines a title with the other filters", async () => {
            const page = await listRecordings(alice(), {
                title: "weekly",
                folder: ref.sales,
            });
            expect(page.recordings.map((r) => r.id)).toEqual(["r3"]);
            expect(page.scanned).toBe(1);
        });

        it("counts a title scan as a search, and nothing else", async () => {
            allowScan.mockClear();
            await listRecordings(alice(), { from: "2026-08-01" });
            expect(allowScan).not.toHaveBeenCalled();
            await listRecordings(alice(), { title: "pricing" });
            expect(allowScan).toHaveBeenCalledTimes(1);
            allowScan.mockResolvedValueOnce(false);
            expect(
                await failure(listRecordings(alice(), { title: "pricing" })),
            ).toMatchObject({
                message: "Too many searches; retry in a minute",
                outcome: "denied",
            });
        });

        it("stops at a page of matches and continues where it stopped", async () => {
            const first = await listRecordings(alice(), { title: "standup" });
            expect(first.recordings).toHaveLength(50);
            expect(first.complete).toBe(false);
            expect(first.continue_before).not.toBeNull();
            expect(first.next_cursor).toBe(first.continue_before);
            const second = await listRecordings(alice(), {
                title: "standup",
                cursor: first.continue_before,
            });
            expect(second.complete).toBe(true);
            expect(
                [...first.recordings, ...second.recordings].map((r) => r.id),
            ).toEqual(allJuly.slice().reverse());
        });
    });

    describe("paging", () => {
        it("walks every page once, ties ordered by id", async () => {
            const args = { from: "2026-07-01", to: "2026-07-31" };
            const first = await listRecordings(alice(), args);
            expect(first.recordings).toHaveLength(50);
            expect(first.next_cursor).not.toBeNull();
            const second = await listRecordings(alice(), {
                ...args,
                cursor: first.next_cursor,
            });
            expect(second.recordings).toHaveLength(JULY - 50);
            expect(second.next_cursor).toBeNull();
            expect(
                [...first.recordings, ...second.recordings].map((r) => r.id),
            ).toEqual(allJuly.slice().reverse());
        });

        it("refuses a cursor it did not make", async () => {
            expect(
                await failure(
                    listRecordings(alice(), { cursor: "not!a!cursor" }),
                ),
            ).toMatchObject({ message: "Invalid cursor" });
        });
    });

    describe("through the MCP server", () => {
        async function connect(caller: McpCaller): Promise<Client> {
            const server = buildMcpServer(RECORDING_TOOLS, caller, null);
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
                "list_folders",
                "list_recordings",
            ]);
            const listing = listed.tools.find(
                (t) => t.name === "list_recordings",
            );
            expect(Object.keys(listing?.inputSchema.properties ?? {})).toEqual([
                "from",
                "to",
                "folder",
                "person",
                "title",
                "cursor",
            ]);

            const recordingsResult = (await client.callTool({
                name: "list_recordings",
                arguments: { from: "2026-09-01", person: "Jan Novotný" },
            })) as CallToolResult;
            expect(recordingsResult.isError).toBeFalsy();
            expect(recordingsResult.structuredContent).toMatchObject({
                recordings: [{ id: "r3", speakers: ["Jan Novotný"] }],
                next_cursor: null,
            });

            const foldersResult = (await client.callTool({
                name: "list_folders",
                arguments: {},
            })) as CallToolResult;
            expect(foldersResult.isError).toBeFalsy();
            expect(
                (
                    foldersResult.structuredContent as {
                        folders: FolderOut[];
                    }
                ).folders.length,
            ).toBeGreaterThan(0);

            const bad = (await client.callTool({
                name: "list_recordings",
                arguments: { to: "soon" },
            })) as CallToolResult;
            expect(bad.isError).toBe(true);
            await client.close();
        });

        it("hides the tools from a caller without a recording role", async () => {
            const client = await connect(alice(["knowledge:read"]));
            expect((await client.listTools()).tools).toEqual([]);
            await client.close();
        });
    });
});
