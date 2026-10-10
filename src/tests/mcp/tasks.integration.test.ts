/**
 * The task tools of the MCP server against a real PostgreSQL: which tasks
 * a user and a service caller list and find, their filters and paging, and
 * `update_task` under the task rules (close as assignee, reassign as the
 * Organization, versions, proposals), plus round trips through the server
 * with the access log.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { z } from "zod";
import { recordingTasks, users } from "@/db/schema";
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
        allowScan: vi.fn(),
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
vi.mock("@/lib/export/document-sidecars", () => ({
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
}));

import { encryptText } from "@/lib/encryption/fields";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import type { McpCaller } from "@/lib/mcp/caller";
import { McpToolError } from "@/lib/mcp/errors";
import { buildMcpServer, type McpToolDef } from "@/lib/mcp/registry";
import type { McpRole } from "@/lib/mcp/roles";
import { TASK_TOOLS } from "@/lib/mcp/tools/tasks";
import { ensureOrgAccount } from "@/lib/org/account";
import {
    insertPerson,
    insertRecording,
    serviceCaller,
    shareRecording,
    userCaller,
} from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";
const CAROL = "user-carol";
const DAVE = "user-dave";
const DAVE_TASKS = 55;

interface TaskOut {
    id: string;
    text: string;
    status: "open" | "done" | "dropped";
    assignee: { id: string; name: string } | null;
    assignee_hint: string | null;
    due_date: string | null;
    due_phrase: string | null;
    quote: string | null;
    start_ms: number | null;
    version: number;
    can_edit: boolean;
    can_close: boolean;
    recording: { id: string; title: string; recorded_at: string; url: string };
    url: string;
}

interface Resolved {
    input: string;
    id: string;
    name: string;
    matched_by: string;
}

interface ListOut {
    tasks: TaskOut[];
    next_cursor: string | null;
    resolved?: Resolved[];
}

interface SearchOut {
    tasks: TaskOut[];
    scanned: number;
    complete: boolean;
    continue_before: string | null;
    resolved?: Resolved[];
}

interface UpdateOut {
    task: TaskOut;
    resolved?: Resolved[];
}

function tool(name: string): McpToolDef {
    const found = TASK_TOOLS.find((entry) => entry.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
}

async function call<T>(
    name: string,
    caller: McpCaller,
    args: Record<string, unknown>,
    touched: string[] = [],
): Promise<T> {
    const definition = tool(name);
    const parsed = z.object(definition.input(caller)).parse(args);
    return (await definition.run({ caller, touched }, parsed)) as unknown as T;
}

async function failure(promise: Promise<unknown>): Promise<McpToolError> {
    const caught = await promise.then(
        () => null,
        (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(McpToolError);
    return caught as McpToolError;
}

describeWithDatabase("MCP task tools (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    const task: Record<string, string> = {};
    const person: Record<string, string> = {};

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    const alice = (roles: McpRole[] = ["tasks:read"]) =>
        userCaller(ALICE, "alice@example.test", roles, orgUserId);
    const bob = (roles: McpRole[] = ["tasks:read", "tasks:write"]) =>
        userCaller(BOB, "bob@example.test", roles, orgUserId);
    const dave = () =>
        userCaller(DAVE, "dave@example.test", ["tasks:read"], orgUserId);
    const service = (
        roles: McpRole[] = ["tasks:read", "tasks:write"],
    ): McpCaller => serviceCaller(orgUserId, roles);

    async function addTask(
        name: string,
        values: {
            recordingId: string;
            userId: string;
            text: string;
            status?: "proposed" | "open" | "done" | "dropped";
            assigneePersonId?: string | null;
            assigneeHint?: string;
            dueDate?: string;
            duePhrase?: string;
            quote?: string;
            evidenceStartMs?: number;
        },
    ): Promise<void> {
        const { text, assigneeHint, duePhrase, quote, recordingId, ...rest } =
            values;
        const [row] = await db()
            .insert(recordingTasks)
            .values({
                status: "open",
                ...rest,
                itemId: recordingId,
                text: encryptText(text),
                assigneeHint: assigneeHint ? encryptText(assigneeHint) : null,
                duePhrase: duePhrase ? encryptText(duePhrase) : null,
                quote: quote ? encryptText(quote) : null,
                source: "riffado",
            })
            .returning({ id: recordingTasks.id });
        if (!row) throw new Error("task not inserted");
        task[name] = row.id;
    }

    const id = (name: string): string => {
        const found = task[name];
        if (!found) throw new Error(`no task ${name}`);
        return found;
    };

    async function listIds(
        caller: McpCaller,
        args: Record<string, unknown> = {},
    ): Promise<string[]> {
        return (await call<ListOut>("list_tasks", caller, args)).tasks.map(
            (row) => row.id,
        );
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_tasks",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
                { id: CAROL, email: "carol@example.test" },
                { id: DAVE, email: "dave@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        if (!orgUserId) throw new Error("organization account missing");

        await insertRecording(db(), {
            id: "a-private",
            userId: ALICE,
            title: "Pricing call",
            startTime: new Date("2026-09-05T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "a-shared",
            userId: ALICE,
            title: "Launch review",
            startTime: new Date("2026-09-06T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "b-private",
            userId: BOB,
            title: "Bob alone",
            startTime: new Date("2026-09-04T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "b-shared",
            userId: BOB,
            title: "Weekly sync",
            startTime: new Date("2026-09-03T10:00:00Z"),
        });
        await insertRecording(db(), { id: "d-private", userId: DAVE });
        await shareRecording(db(), "a-shared", orgUserId);
        await shareRecording(db(), "b-shared", orgUserId);

        person.alicePetra = await insertPerson(db(), ALICE, "Petra Malá");
        person.orgBob = await insertPerson(db(), orgUserId, "Bob Bauer", {
            emailHash: lookupHash("bob@example.test"),
        });
        person.orgCarol = await insertPerson(db(), orgUserId, "Carol Cole", {
            emailHash: lookupHash("carol@example.test"),
        });
        person.dana1 = await insertPerson(db(), orgUserId, "Dana Smith");
        person.dana2 = await insertPerson(db(), orgUserId, "Dana Smith");

        await addTask("alicePrivate", {
            recordingId: "a-private",
            userId: ALICE,
            text: "Draft the pricing page",
            assigneePersonId: person.alicePetra,
            dueDate: "2026-10-10",
            duePhrase: "by Friday",
            quote: "Petra needs the pricing page ready by Friday",
            evidenceStartMs: 12_000,
        });
        await addTask("aliceSharedBob", {
            recordingId: "a-shared",
            userId: ALICE,
            text: "Book the venue",
            assigneePersonId: person.orgBob,
            dueDate: "2026-10-20",
            quote: "Bob will book the venue",
        });
        await addTask("aliceSharedDone", {
            recordingId: "a-shared",
            userId: ALICE,
            text: "Send the invitations",
            status: "done",
            assigneeHint: "Dana",
        });
        await addTask("bobPrivate", {
            recordingId: "b-private",
            userId: BOB,
            text: "Renew the passport",
        });
        await addTask("bobSharedCarol", {
            recordingId: "b-shared",
            userId: BOB,
            text: "Prepare the budget",
            assigneePersonId: person.orgCarol,
            quote: "Carol prepares the budget",
        });
        await addTask("proposal", {
            recordingId: "a-shared",
            userId: ALICE,
            text: "Order the catering",
            status: "proposed",
        });
        await addTask("closeMe", {
            recordingId: "a-shared",
            userId: ALICE,
            text: "Print the badges",
            assigneePersonId: person.orgBob,
        });
        await addTask("reassignMe", {
            recordingId: "b-shared",
            userId: BOB,
            text: "Call the caterer",
            assigneePersonId: person.orgCarol,
        });
        for (let n = 0; n < DAVE_TASKS; n++) {
            await addTask(`dave${n}`, {
                recordingId: "d-private",
                userId: DAVE,
                text: `Standup item ${n}`,
            });
        }
        knowledgeStore().invalidateAll();
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(() => {
        audit.mockReset();
        allowScan.mockReset();
        allowScan.mockResolvedValue(true);
    });

    describe("list_tasks", () => {
        it("shows a user their recordings' tasks and the shared ones assigned to them", async () => {
            expect(new Set(await listIds(alice(), { status: "all" }))).toEqual(
                new Set([
                    id("alicePrivate"),
                    id("aliceSharedBob"),
                    id("aliceSharedDone"),
                    id("closeMe"),
                ]),
            );
            expect(new Set(await listIds(bob(), { status: "all" }))).toEqual(
                new Set([
                    id("aliceSharedBob"),
                    id("closeMe"),
                    id("bobPrivate"),
                    id("bobSharedCarol"),
                    id("reassignMe"),
                ]),
            );
        });

        it("never shows another user's private tasks or a proposal", async () => {
            const forBob = await listIds(bob(), { status: "all" });
            expect(forBob).not.toContain(id("alicePrivate"));
            const forAlice = await listIds(alice(), { status: "all" });
            expect(forAlice).not.toContain(id("bobPrivate"));
            expect(forAlice).not.toContain(id("bobSharedCarol"));
            for (const caller of [alice(), bob(), service()]) {
                expect(await listIds(caller, { status: "all" })).not.toContain(
                    id("proposal"),
                );
            }
        });

        it("shows a service caller the shared recordings' tasks alone", async () => {
            expect(
                new Set(await listIds(service(), { status: "all" })),
            ).toEqual(
                new Set([
                    id("aliceSharedBob"),
                    id("aliceSharedDone"),
                    id("closeMe"),
                    id("bobSharedCarol"),
                    id("reassignMe"),
                ]),
            );
        });

        it("lists open tasks by default, with every field", async () => {
            const page = await call<ListOut>("list_tasks", alice(), {});
            expect(new Set(page.tasks.map((row) => row.id))).toEqual(
                new Set([
                    id("alicePrivate"),
                    id("aliceSharedBob"),
                    id("closeMe"),
                ]),
            );
            expect(page.next_cursor).toBeNull();
            expect(
                page.tasks.find((row) => row.id === id("alicePrivate")),
            ).toEqual({
                id: id("alicePrivate"),
                text: "Draft the pricing page",
                status: "open",
                assignee: { id: person.alicePetra, name: "Petra Malá" },
                assignee_hint: null,
                due_date: "2026-10-10",
                due_phrase: "by Friday",
                quote: "Petra needs the pricing page ready by Friday",
                start_ms: 12_000,
                kind: "audio",
                version: 0,
                can_edit: false,
                can_close: false,
                recording: {
                    id: "a-private",
                    title: "Pricing call",
                    recorded_at: "2026-09-05T10:00:00.000Z",
                    url: "https://riffado.example.test/dashboard?recording=a-private",
                },
                url: "https://riffado.example.test/dashboard?recording=a-private",
            });
        });

        it("says what update_task may do only with tasks:write", async () => {
            const writer = await call<ListOut>(
                "list_tasks",
                alice(["tasks:read", "tasks:write"]),
                {},
            );
            expect(
                writer.tasks.find((row) => row.id === id("alicePrivate")),
            ).toMatchObject({ can_edit: true, can_close: true });
            const forBob = await call<ListOut>("list_tasks", bob(), {});
            expect(
                forBob.tasks.find((row) => row.id === id("aliceSharedBob")),
            ).toMatchObject({
                can_edit: false,
                can_close: true,
                url: "https://riffado.example.test/dashboard?recording=a-shared&view=org",
            });
        });

        it("filters by assignee name, due day and recording title", async () => {
            const byAssignee = await call<ListOut>("list_tasks", alice(), {
                assignee: "bob bauer",
            });
            expect(new Set(byAssignee.tasks.map((row) => row.id))).toEqual(
                new Set([id("aliceSharedBob"), id("closeMe")]),
            );
            expect(byAssignee.resolved).toEqual([
                {
                    input: "bob bauer",
                    id: person.orgBob,
                    name: "Bob Bauer",
                    matched_by: "exact",
                },
            ]);
            expect(
                await listIds(alice(), { due_before: "2026-10-15" }),
            ).toEqual([id("alicePrivate")]);
            const byRecording = await call<ListOut>("list_tasks", alice(), {
                recording: "launch review",
                status: "done",
            });
            expect(byRecording.tasks.map((row) => row.id)).toEqual([
                id("aliceSharedDone"),
            ]);
            expect(byRecording.resolved?.[0]).toMatchObject({
                id: "a-shared",
                name: "Launch review",
            });
        });

        it("refuses a bad due day and a name it cannot see", async () => {
            expect(
                await failure(
                    call("list_tasks", alice(), { due_before: "next week" }),
                ),
            ).toMatchObject({ outcome: "invalid" });
            expect(
                await failure(
                    call("list_tasks", alice(), { assignee: "Carol Cole" }),
                ),
            ).toMatchObject({ outcome: "not_found" });
        });

        it("pages newest first by keyset, each task once", async () => {
            const first = await call<ListOut>("list_tasks", dave(), {});
            expect(first.tasks).toHaveLength(50);
            expect(first.next_cursor).not.toBeNull();
            const second = await call<ListOut>("list_tasks", dave(), {
                cursor: first.next_cursor,
            });
            expect(second.next_cursor).toBeNull();
            const all = [...first.tasks, ...second.tasks].map((row) => row.id);
            expect(all).toHaveLength(DAVE_TASKS);
            expect(new Set(all)).toEqual(
                new Set(
                    Array.from({ length: DAVE_TASKS }, (_, n) =>
                        id(`dave${n}`),
                    ),
                ),
            );
            expect(
                await failure(
                    call("list_tasks", dave(), { cursor: "not!a!cursor" }),
                ),
            ).toMatchObject({ message: "Invalid cursor" });
        });

        it("logs the tasks it returned", async () => {
            const touched: string[] = [];
            const page = await call<ListOut>(
                "list_tasks",
                service(),
                {},
                touched,
            );
            expect(touched).toEqual(page.tasks.map((row) => row.id));
        });
    });

    describe("search_tasks", () => {
        it("finds a task by words of its quote or its assignee hint", async () => {
            const byQuote = await call<SearchOut>("search_tasks", alice(), {
                query: "FRIDAY",
            });
            expect(byQuote.tasks.map((row) => row.id)).toEqual([
                id("alicePrivate"),
            ]);
            expect(byQuote.complete).toBe(true);
            expect(byQuote.continue_before).toBeNull();
            expect(byQuote.scanned).toBe(4);
            const byHint = await call<SearchOut>("search_tasks", alice(), {
                query: "dana",
            });
            expect(byHint.tasks.map((row) => row.id)).toEqual([
                id("aliceSharedDone"),
            ]);
            expect(
                (
                    await call<SearchOut>("search_tasks", bob(), {
                        query: "friday",
                    })
                ).tasks,
            ).toEqual([]);
        });

        it("narrows by the recording filters and the task filters", async () => {
            const shared = await call<SearchOut>("search_tasks", alice(), {
                query: "the",
                from: "2026-09-06",
            });
            expect(new Set(shared.tasks.map((row) => row.id))).toEqual(
                new Set([
                    id("aliceSharedBob"),
                    id("aliceSharedDone"),
                    id("closeMe"),
                ]),
            );
            const open = await call<SearchOut>("search_tasks", alice(), {
                query: "the",
                from: "2026-09-06",
                status: "open",
                assignee: person.orgBob,
            });
            expect(new Set(open.tasks.map((row) => row.id))).toEqual(
                new Set([id("aliceSharedBob"), id("closeMe")]),
            );
            expect(
                (
                    await call<SearchOut>("search_tasks", service(), {
                        query: "budget",
                    })
                ).tasks.map((row) => row.id),
            ).toEqual([id("bobSharedCarol")]);
        });

        it("has no entity filter without knowledge:read", () => {
            const search = tool("search_tasks");
            expect(Object.keys(search.input(alice()))).not.toContain("entity");
            expect(
                Object.keys(
                    search.input(alice(["tasks:read", "knowledge:read"])),
                ),
            ).toContain("entity");
        });

        it("is refused when the caller is over its search budget", async () => {
            allowScan.mockResolvedValue(false);
            expect(
                await failure(
                    call("search_tasks", alice(), { query: "friday" }),
                ),
            ).toMatchObject({
                outcome: "denied",
                message: "Too many searches; retry in a minute",
            });
        });
    });

    describe("update_task", () => {
        it("lets the assignee close a shared task but not reassign it", async () => {
            const closed = await call<UpdateOut>("update_task", bob(), {
                task: id("closeMe"),
                version: 0,
                status: "done",
            });
            expect(closed.task).toMatchObject({
                id: id("closeMe"),
                status: "done",
                version: 1,
                can_close: true,
                can_edit: false,
                recording: { id: "a-shared", title: "Launch review" },
            });
            expect(
                await failure(
                    call(
                        "update_task",
                        bob(["tasks:read", "tasks:write", "knowledge:read"]),
                        {
                            task: id("closeMe"),
                            version: 1,
                            assignee: "Carol Cole",
                        },
                    ),
                ),
            ).toMatchObject({
                outcome: "denied",
                message: "Not allowed to change this task",
            });
            const [row] = await db()
                .select({
                    status: recordingTasks.status,
                    by: recordingTasks.statusChangedByUserId,
                    assignee: recordingTasks.assigneePersonId,
                })
                .from(recordingTasks)
                .where(eq(recordingTasks.id, id("closeMe")));
            expect(row).toEqual({
                status: "done",
                by: BOB,
                assignee: person.orgBob,
            });
        });

        it("refuses a stale version with the task as it is now", async () => {
            const error = await failure(
                call("update_task", bob(), {
                    task: id("closeMe"),
                    version: 0,
                    status: "open",
                }),
            );
            expect(error).toMatchObject({
                outcome: "conflict",
                message: "The task changed since you read it",
            });
            expect(error.details).toMatchObject({
                current: { id: id("closeMe"), status: "done", version: 1 },
            });
        });

        it("reassigns by name as the Organization, and clears", async () => {
            const reassigned = await call<UpdateOut>("update_task", service(), {
                task: id("reassignMe"),
                version: 0,
                assignee: "bob bauer",
            });
            expect(reassigned.task).toMatchObject({
                assignee: { id: person.orgBob, name: "Bob Bauer" },
                version: 1,
                can_edit: true,
            });
            expect(reassigned.resolved).toEqual([
                {
                    input: "bob bauer",
                    id: person.orgBob,
                    name: "Bob Bauer",
                    matched_by: "exact",
                },
            ]);
            const cleared = await call<UpdateOut>("update_task", service(), {
                task: id("reassignMe"),
                version: 1,
                assignee: null,
            });
            expect(cleared.task.assignee).toBeNull();
            expect(cleared.resolved).toBeUndefined();
        });

        it("answers an ambiguous name with its candidates", async () => {
            const error = await failure(
                call(
                    "update_task",
                    service(["tasks:read", "tasks:write", "knowledge:read"]),
                    {
                        task: id("reassignMe"),
                        version: 2,
                        assignee: "Dana Smith",
                    },
                ),
            );
            expect(error).toMatchObject({
                outcome: "invalid",
                message: "Ambiguous name",
            });
            expect(
                new Set(
                    (
                        error.details as { candidates: { id: string }[] }
                    ).candidates.map((candidate) => candidate.id),
                ),
            ).toEqual(new Set([person.dana1, person.dana2]));
        });

        it("cannot change a proposal or a task off the caller's lists", async () => {
            for (const args of [
                { task: id("proposal"), version: 0, status: "open" },
                { task: id("proposal"), version: 0, assignee: null },
            ]) {
                expect(
                    await failure(call("update_task", service(), args)),
                ).toMatchObject({ outcome: "not_found" });
            }
            expect(
                await failure(
                    call("update_task", bob(), {
                        task: id("alicePrivate"),
                        version: 0,
                        status: "done",
                    }),
                ),
            ).toMatchObject({ outcome: "not_found" });
            expect(
                await failure(
                    call("update_task", service(), {
                        task: id("bobPrivate"),
                        version: 0,
                        status: "done",
                    }),
                ),
            ).toMatchObject({ outcome: "not_found" });
        });

        it("needs a status or an assignee", async () => {
            expect(
                await failure(
                    call("update_task", service(), {
                        task: id("bobSharedCarol"),
                        version: 0,
                    }),
                ),
            ).toMatchObject({ outcome: "invalid" });
        });

        it("leaves reassigning a shared task to the Organization, not its owner", async () => {
            expect(
                await failure(
                    call(
                        "update_task",
                        alice(["tasks:read", "tasks:write", "knowledge:read"]),
                        {
                            task: id("aliceSharedBob"),
                            version: 0,
                            assignee: "Petra Malá",
                        },
                    ),
                ),
            ).toMatchObject({ outcome: "denied" });
        });
    });

    describe("through the MCP server", () => {
        async function connect(caller: McpCaller): Promise<Client> {
            const server = buildMcpServer(TASK_TOOLS, caller, null);
            const [clientSide, serverSide] =
                InMemoryTransport.createLinkedPair();
            await server.connect(serverSide);
            const client = new Client({ name: "test", version: "1" });
            await client.connect(clientSide);
            return client;
        }

        it("lists update_task only with tasks:write", async () => {
            const reader = await connect(alice());
            expect((await reader.listTools()).tools.map((t) => t.name)).toEqual(
                ["list_tasks", "search_tasks"],
            );
            await reader.close();
            const writer = await connect(service());
            const listed = await writer.listTools();
            expect(listed.tools.map((t) => t.name)).toEqual([
                "list_tasks",
                "search_tasks",
                "update_task",
            ]);
            expect(
                listed.tools.find((t) => t.name === "update_task")?.annotations,
            ).toMatchObject({
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
            });
            await writer.close();
        });

        it("answers within the output schemas and logs the task changed", async () => {
            const client = await connect(service());
            const listed = (await client.callTool({
                name: "list_tasks",
                arguments: {},
            })) as CallToolResult;
            expect(listed.isError).toBeFalsy();
            const current = (
                listed.structuredContent as unknown as ListOut
            ).tasks.find((row) => row.id === id("bobSharedCarol"));
            expect(current).toBeDefined();

            audit.mockReset();
            const updated = (await client.callTool({
                name: "update_task",
                arguments: {
                    task: id("bobSharedCarol"),
                    version: current?.version,
                    status: "dropped",
                },
            })) as CallToolResult;
            expect(updated.isError).toBeFalsy();
            expect(
                (updated.structuredContent as unknown as UpdateOut).task,
            ).toMatchObject({ id: id("bobSharedCarol"), status: "dropped" });
            expect(audit).toHaveBeenCalledTimes(1);
            expect(audit.mock.calls[0]?.[0]).toMatchObject({
                tool: "update_task",
                outcome: "ok",
                targetIds: [id("bobSharedCarol")],
            });

            audit.mockReset();
            const stale = (await client.callTool({
                name: "update_task",
                arguments: {
                    task: id("bobSharedCarol"),
                    version: current?.version,
                    status: "open",
                },
            })) as CallToolResult;
            expect(stale.isError).toBe(true);
            const body = JSON.parse(
                (stale.content as { type: "text"; text: string }[])[0]?.text ??
                    "{}",
            ) as { error: string; details: { current: TaskOut } };
            expect(body.error).toBe("The task changed since you read it");
            expect(body.details.current).toMatchObject({
                id: id("bobSharedCarol"),
                status: "dropped",
            });
            expect(audit.mock.calls[0]?.[0]).toMatchObject({
                tool: "update_task",
                outcome: "conflict",
                targetIds: [id("bobSharedCarol")],
            });

            const searched = (await client.callTool({
                name: "search_tasks",
                arguments: { query: "caterer" },
            })) as CallToolResult;
            expect(searched.isError).toBeFalsy();
            expect(
                (searched.structuredContent as unknown as SearchOut).tasks.map(
                    (row) => row.id,
                ),
            ).toEqual([id("reassignMe")]);
            await client.close();
        });
    });
});
