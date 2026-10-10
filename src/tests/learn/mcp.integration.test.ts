/**
 * The MCP endpoint a Learn run's model calls, against a real PostgreSQL:
 * only a running run's token opens it, and it answers from that run's
 * scopes alone, within the run's lookups.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

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
import {
    learnRuns,
    transcriptCorrectionPasses,
    transcriptions,
    users,
} from "@/db/schema";
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
            KNOWLEDGE_MEMORY_MB: 64,
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

import { POST as postMcp } from "@/app/api/mcp/learn/route";
import { encryptText } from "@/lib/encryption/fields";
import { createEntity } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { MCP_MAX_BODY_BYTES, MCP_TOOL_BUDGET } from "@/lib/learn/mcp";
import {
    issueCorrectionPassToken,
    issueLearnRunToken,
} from "@/lib/learn/run-token";
import { ensureOrgAccount } from "@/lib/org/account";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";
const REC = "rec-mcp";

describeWithDatabase("the Learn MCP endpoint (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let runId = "";
    let orion = "";
    let bobsOrion = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "learn_mcp",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        knowledgeStore().invalidateAll();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        await ensureOrgAccount();
        await seedCoreVocabulary();
        orion = (
            await createEntity(ALICE, { typeKey: "project", name: "Orion" })
        ).id;
        bobsOrion = (
            await createEntity(BOB, { typeKey: "project", name: "Orion" })
        ).id;
        await insertRecordings(db(), {
            id: REC,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 5_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:05Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/rec.mp3`,
            plaudVersion: "1",
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: ALICE,
                text: encryptText("Orijon."),
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: ALICE,
                scopeUserId: ALICE,
                itemId: REC,
                transcriptionId: transcript?.id ?? "",
                view: "private",
                actorUserId: ALICE,
                trigger: "manual",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "running",
            })
            .returning({ id: learnRuns.id });
        runId = run?.id ?? "";
    });

    function mcp(
        body: unknown,
        token: string | null = issueLearnRunToken(runId),
    ) {
        return postMcp(
            new Request("http://localhost/api/mcp/learn", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(token ? { authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify(body),
            }),
        );
    }

    const call = (id: number, name: string, args: object) =>
        mcp({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
        });

    const payloadOf = async (response: Response) =>
        JSON.parse(
            (
                (await response.json()) as {
                    result: { content: { text: string }[] };
                }
            ).result.content[0]?.text ?? "null",
        );

    it("opens only to a running run's token", async () => {
        const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
        expect((await mcp(list, null)).status).toBe(401);
        expect((await mcp(list, "lr1.x.1.forged")).status).toBe(401);
        expect(
            (await mcp(list, issueLearnRunToken("no-such-run"))).status,
        ).toBe(401);
        const listed = await mcp(list);
        expect(listed.status).toBe(200);
        await expect(listed.json()).resolves.toMatchObject({
            result: {
                tools: [
                    { name: "find_entities" },
                    { name: "get_entity" },
                    { name: "find_facts" },
                ],
            },
        });

        await db()
            .update(learnRuns)
            .set({ status: "ready" })
            .where(eq(learnRuns.id, runId));
        expect((await mcp(list)).status).toBe(401);
    });

    it("answers the handshake, and a notification with nothing", async () => {
        const initialized = await mcp({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: "2025-06-18" },
        });
        await expect(initialized.json()).resolves.toMatchObject({
            result: { capabilities: { tools: {} } },
        });
        expect(
            (await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }))
                .status,
        ).toBe(202);
    });

    it("answers from the run's scopes alone", async () => {
        const found = await payloadOf(
            await call(2, "find_entities", { text: "Orijon" }),
        );
        expect(
            found.entities.map((entity: { id: string }) => entity.id),
        ).toEqual([orion]);
        expect(
            await payloadOf(await call(3, "get_entity", { id: bobsOrion })),
        ).toBeNull();
        expect(
            await payloadOf(await call(4, "find_facts", { id: bobsOrion })),
        ).toEqual([]);
    });

    it("refuses a body over its limit, and an id JSON-RPC does not allow", async () => {
        const big = await mcp({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: { padding: "x".repeat(MCP_MAX_BODY_BYTES) },
        });
        expect(big.status).toBe(413);
        // Streamed, with no length said up front.
        const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
        let sent = 0;
        const streamed = await postMcp(
            new Request("http://localhost/api/mcp/learn", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${issueLearnRunToken(runId)}`,
                },
                body: new ReadableStream({
                    pull(controller) {
                        if (sent > MCP_MAX_BODY_BYTES * 2) {
                            controller.close();
                            return;
                        }
                        sent += chunk.length;
                        controller.enqueue(chunk);
                    },
                }),
                duplex: "half",
            } as RequestInit),
        );
        expect(streamed.status).toBe(413);

        for (const id of [{ nested: true }, [1], 1.5, "x".repeat(201)]) {
            const answered = await mcp({
                jsonrpc: "2.0",
                id,
                method: "tools/list",
            });
            await expect(answered.json()).resolves.toEqual({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32600, message: "Invalid request" },
            });
        }
    });

    it("stops a run that used its lookups", async () => {
        await db()
            .update(learnRuns)
            .set({ stats: { tool_calls: MCP_TOOL_BUDGET } })
            .where(eq(learnRuns.id, runId));
        const refused = await call(5, "get_entity", { id: orion });
        await expect(refused.json()).resolves.toMatchObject({
            result: { isError: true },
        });
    });

    it("opens to a running correction pass's token, counting its own lookups", async () => {
        const [transcript] = await db()
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, REC));
        const [pass] = await db()
            .insert(transcriptCorrectionPasses)
            .values({
                userId: ALICE,
                scopeUserId: ALICE,
                recordingId: REC,
                transcriptionId: transcript?.id ?? "",
                transcriptRevision: 0,
                view: "private",
                actorUserId: ALICE,
                status: "running",
            })
            .returning({ id: transcriptCorrectionPasses.id });
        const passToken = issueCorrectionPassToken(pass?.id ?? "");
        const lookup = {
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: { name: "get_entity", arguments: { id: orion } },
        };
        const answered = await mcp(lookup, passToken);
        expect(answered.status).toBe(200);
        await expect(payloadOf(answered)).resolves.toMatchObject({
            name: "Orion",
        });
        const [counted] = await db()
            .select({ stats: transcriptCorrectionPasses.stats })
            .from(transcriptCorrectionPasses)
            .where(eq(transcriptCorrectionPasses.id, pass?.id ?? ""));
        expect(counted?.stats).toEqual({ tool_calls: 1 });
        // A pass's token is not a run's, nor the other way round.
        expect(
            (await mcp(lookup, issueLearnRunToken(pass?.id ?? ""))).status,
        ).toBe(401);
        expect(
            (await mcp(lookup, issueCorrectionPassToken(runId))).status,
        ).toBe(401);

        await db()
            .update(transcriptCorrectionPasses)
            .set({ status: "finished" })
            .where(eq(transcriptCorrectionPasses.id, pass?.id ?? ""));
        expect((await mcp(lookup, passToken)).status).toBe(401);
    });
});
