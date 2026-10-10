/**
 * `listCallerTasks` against a real PostgreSQL: the union of the Tasks
 * page's tabs for a user and for the Organization, never a proposal or a
 * deleted recording's task, its filters, and newest-first keyset paging.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recordings, recordingTasks, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
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
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
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
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { ensureOrgAccount } from "@/lib/org/account";
import { type TaskViewer, taskViewer } from "@/lib/tasks/access";
import {
    type CallerTaskQuery,
    getCallerTask,
    listCallerTasks,
    listTasks,
    type TaskListQuery,
} from "@/lib/tasks/tasks";
import {
    insertPerson,
    insertRecording,
    shareRecording,
} from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";
const CAROL = "user-carol";
const PAGE_TASKS = 7;

const tab = (name: "mine" | "tracked"): TaskListQuery => ({
    tab: name,
    state: "all",
    folderId: null,
    due: null,
    today: null,
    sort: "created",
});

const everything: CallerTaskQuery = {
    status: "all",
    assigneePersonId: null,
    recordingId: null,
    dueBefore: null,
    recordingCondition: null,
    after: null,
    limit: 500,
};

describeWithDatabase("listCallerTasks (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    const viewers: Record<string, TaskViewer> = {};
    const task: Record<string, string> = {};
    const person: Record<string, string> = {};

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    function withoutRecordingId<T extends { recordingId: string }>(
        values: T,
    ): Omit<T, "recordingId"> {
        const { recordingId: _recordingId, ...rest } = values;
        return rest;
    }

    async function addTask(
        name: string,
        values: {
            recordingId: string;
            userId: string;
            status?: "proposed" | "open" | "done" | "dropped";
            assigneePersonId?: string | null;
            dueDate?: string | null;
            createdAt: Date;
        },
    ): Promise<void> {
        const [row] = await db()
            .insert(recordingTasks)
            .values({
                status: "open",
                ...withoutRecordingId(values),
                itemId: values.recordingId,
                text: encryptText(`Task ${name}`),
                source: "manual",
            })
            .returning({ id: recordingTasks.id });
        if (!row) throw new Error("task not inserted");
        task[name] = row.id;
    }

    const at = (minute: number) =>
        new Date(Date.UTC(2026, 9, 1, 9, minute, 0, 0));

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "list_caller_tasks",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
                { id: CAROL, email: "carol@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        if (!orgUserId) throw new Error("organization account missing");

        await insertRecording(db(), { id: "a-private", userId: ALICE });
        await insertRecording(db(), { id: "a-shared", userId: ALICE });
        await insertRecording(db(), { id: "b-private", userId: BOB });
        await insertRecording(db(), { id: "b-shared", userId: BOB });
        await insertRecording(db(), {
            id: "a-deleted",
            userId: ALICE,
            deletedAt: new Date("2026-09-30T00:00:00Z"),
        });
        await shareRecording(db(), "a-shared", orgUserId);
        await shareRecording(db(), "b-shared", orgUserId);

        person.aliceBob = await insertPerson(db(), ALICE, "Bob", {
            emailHash: lookupHash("bob@example.test"),
        });
        person.orgBob = await insertPerson(db(), orgUserId, "Bob B.", {
            emailHash: lookupHash("bob@example.test"),
        });
        person.orgCarol = await insertPerson(db(), orgUserId, "Carol", {
            emailHash: lookupHash("carol@example.test"),
        });

        await addTask("alicePrivateForBob", {
            recordingId: "a-private",
            userId: ALICE,
            assigneePersonId: person.aliceBob,
            dueDate: "2026-10-10",
            createdAt: at(1),
        });
        await addTask("aliceSharedForBob", {
            recordingId: "a-shared",
            userId: ALICE,
            assigneePersonId: person.orgBob,
            dueDate: "2026-10-20",
            createdAt: at(2),
        });
        await addTask("aliceSharedDone", {
            recordingId: "a-shared",
            userId: ALICE,
            status: "done",
            createdAt: at(3),
        });
        await addTask("bobPrivateDropped", {
            recordingId: "b-private",
            userId: BOB,
            status: "dropped",
            createdAt: at(4),
        });
        await addTask("bobSharedForCarol", {
            recordingId: "b-shared",
            userId: BOB,
            assigneePersonId: person.orgCarol,
            createdAt: at(5),
        });
        await addTask("bobSharedForBob", {
            recordingId: "b-shared",
            userId: BOB,
            assigneePersonId: person.orgBob,
            createdAt: at(6),
        });
        await addTask("aliceProposal", {
            recordingId: "a-private",
            userId: ALICE,
            status: "proposed",
            createdAt: at(7),
        });
        await addTask("aliceDeleted", {
            recordingId: "a-deleted",
            userId: ALICE,
            createdAt: at(8),
        });
        // Equal creation times (to the microsecond): ordered by id alone.
        for (let n = 0; n < PAGE_TASKS; n++) {
            await addTask(`batch${n}`, {
                recordingId: "a-private",
                userId: ALICE,
                createdAt: new Date(Date.UTC(2026, 8, 1, 9, 0, 0, 0)),
            });
        }

        viewers.alice = await taskViewer({
            id: ALICE,
            email: "alice@example.test",
        });
        viewers.bob = await taskViewer({ id: BOB, email: "bob@example.test" });
        viewers.carol = await taskViewer({
            id: CAROL,
            email: "carol@example.test",
        });
        viewers.org = await taskViewer({
            id: orgUserId,
            email: "org@example.test",
        });
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    const viewer = (name: string): TaskViewer => {
        const found = viewers[name];
        if (!found) throw new Error(`no viewer ${name}`);
        return found;
    };

    async function ids(
        name: string,
        query: Partial<CallerTaskQuery> = {},
    ): Promise<string[]> {
        return (
            await listCallerTasks(viewer(name), { ...everything, ...query })
        ).map((row) => row.id);
    }

    const batch = () =>
        Array.from({ length: PAGE_TASKS }, (_, n) => task[`batch${n}`] ?? "");

    it.each([
        "alice",
        "bob",
        "carol",
        "org",
    ])("equals the Tasks page's two tabs together for %s", async (name) => {
        const [mine, tracked] = await Promise.all([
            listTasks(viewer(name), tab("mine")),
            listTasks(viewer(name), tab("tracked")),
        ]);
        const union = new Set([...mine, ...tracked].map((row) => row.id));
        expect(new Set(await ids(name))).toEqual(union);
    });

    it("shows a user their recordings' tasks and the shared ones assigned to them", async () => {
        expect(new Set(await ids("alice"))).toEqual(
            new Set([
                task.alicePrivateForBob,
                task.aliceSharedForBob,
                task.aliceSharedDone,
                ...batch(),
            ]),
        );
        expect(new Set(await ids("bob"))).toEqual(
            new Set([
                task.aliceSharedForBob,
                task.bobPrivateDropped,
                task.bobSharedForCarol,
                task.bobSharedForBob,
            ]),
        );
        expect(await ids("carol")).toEqual([task.bobSharedForCarol]);
    });

    it("shows the Organization every shared recording's tasks", async () => {
        expect(new Set(await ids("org"))).toEqual(
            new Set([
                task.aliceSharedForBob,
                task.aliceSharedDone,
                task.bobSharedForCarol,
                task.bobSharedForBob,
            ]),
        );
    });

    it("never lists a proposal or a deleted recording's task", async () => {
        for (const name of ["alice", "bob", "carol", "org"]) {
            const listed = await ids(name);
            expect(listed).not.toContain(task.aliceProposal);
            expect(listed).not.toContain(task.aliceDeleted);
        }
        expect(
            await getCallerTask(viewer("alice"), task.aliceProposal ?? ""),
        ).toBeNull();
    });

    it("filters by status, assignee, recording, due day and recording condition", async () => {
        expect(await ids("bob", { status: "dropped" })).toEqual([
            task.bobPrivateDropped,
        ]);
        expect(await ids("alice", { status: "done" })).toEqual([
            task.aliceSharedDone,
        ]);
        expect(
            await ids("org", { assigneePersonId: person.orgBob ?? null }),
        ).toEqual([task.bobSharedForBob, task.aliceSharedForBob]);
        expect(await ids("org", { recordingId: "a-shared" })).toEqual([
            task.aliceSharedDone,
            task.aliceSharedForBob,
        ]);
        expect(await ids("alice", { dueBefore: "2026-10-20" })).toEqual([
            task.alicePrivateForBob,
        ]);
        expect(await ids("alice", { dueBefore: "2026-10-21" })).toEqual([
            task.aliceSharedForBob,
            task.alicePrivateForBob,
        ]);
        expect(
            await ids("bob", {
                recordingCondition: eq(recordings.userId, ALICE),
            }),
        ).toEqual([task.aliceSharedForBob]);
    });

    it("orders newest first and pages by keyset, ties by id", async () => {
        const all = await listCallerTasks(viewer("alice"), everything);
        expect(all.slice(0, 3).map((row) => row.id)).toEqual([
            task.aliceSharedDone,
            task.aliceSharedForBob,
            task.alicePrivateForBob,
        ]);
        const seen: string[] = [];
        let after: CallerTaskQuery["after"] = null;
        for (;;) {
            const page = await listCallerTasks(viewer("alice"), {
                ...everything,
                after,
                limit: 2,
            });
            if (page.length === 0) break;
            seen.push(...page.map((row) => row.id));
            const last = page.at(-1);
            if (!last) break;
            after = { at: new Date(last.createdAt), id: last.id };
        }
        expect(seen).toEqual(all.map((row) => row.id));
        expect(new Set(seen.slice(3))).toEqual(new Set(batch()));
    });

    it("reads one task of the viewer's lists, with its recording", async () => {
        const one = await getCallerTask(
            viewer("bob"),
            task.aliceSharedForBob ?? "",
        );
        expect(one).toMatchObject({
            id: task.aliceSharedForBob,
            text: "Task aliceSharedForBob",
            assignee: { personId: person.orgBob, name: "Bob B." },
            canEdit: false,
            canClose: true,
            recording: { id: "a-shared", view: "org" },
        });
        expect(
            await getCallerTask(viewer("carol"), task.aliceSharedForBob ?? ""),
        ).toBeNull();
    });
});
