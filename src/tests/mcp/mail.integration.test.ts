/**
 * Mail through the MCP server against a real PostgreSQL (D8): without
 * `mail:read` no tool returns a mail, its words or its source, while the
 * tasks and facts learned from it stay listed under their own roles; with
 * it the mail tools read the pile, every result flagged untrusted, and
 * secret addresses masked even for their owner.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
    accounts,
    apiCredentials,
    mailContents,
    mailMessages,
    recordingFolders,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, createCompletion } = vi.hoisted(() => {
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
        createCompletion: vi.fn(),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared" as const,
            APP_URL: "https://riffado.example.test",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: undefined,
            ORG_ACCOUNT_NAME: undefined,
            OIDC_ISSUER_URL: "https://sso.example.test/realms/acme",
            OIDC_CLIENT_ID: "riffado",
            OIDC_CLIENT_SECRET: "secret",
            MAIL_DOMAIN: "klepna.example",
            MAIL_ORG_NICKNAME: "acme",
            MAIL_FORMER_ORG_NICKNAMES: [] as string[],
            MAIL_ADDRESS_HASH_SECRET: "m".repeat(40),
            MAIL_INGEST_SECRET: "i".repeat(40),
            MAIL_INACTIVE_DAYS: 180,
            MAIL_MAX_SIGNATURE_AGE_HOURS: 72,
            MAIL_DAILY_LIMIT: 500,
            MAIL_MAX_MESSAGE_MB: 36,
            DEFAULT_STORAGE_TYPE: "local" as const,
            LOCAL_STORAGE_PATH: "",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 100,
            KNOWLEDGE_MEMORY_MB: 64,
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAccess: vi.fn() }));
vi.mock("@/lib/mcp/rate-limit", () => ({
    allowMcpScan: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("openai")>();
    return {
        ...actual,
        OpenAI: class {
            chat = { completions: { create: createCompletion } };
        },
    };
});

import { encrypt } from "@/lib/encryption";
import { addRecordingToFolder, ensureRootFolders } from "@/lib/folders/folders";
import { confirmFactFromMailInTx } from "@/lib/knowledge/facts";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { createPerson } from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { createSecretAddress, ensureMailbox } from "@/lib/mail/addresses";
import { authenticateMessage } from "@/lib/mail/dkim";
import { ingestMail, precheckMail } from "@/lib/mail/ingest";
import type { McpCaller } from "@/lib/mcp/caller";
import { allowedTools } from "@/lib/mcp/registry";
import type { McpRole } from "@/lib/mcp/roles";
import { ALL_TOOLS } from "@/lib/mcp/tools";
import { ensureOrgAccount } from "@/lib/org/account";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { taskViewerById } from "@/lib/tasks/access";
import { acceptReview } from "@/lib/tasks/tasks";
import {
    rawMessage,
    signMessage,
    testResolver,
    testSigner,
} from "@/tests/mail/dkim-fixtures";
import { serviceCaller, userCaller } from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const company = testSigner("company.example");
const resolver = testResolver([company]);

interface TaskOut {
    id: string;
    text: string;
    kind: "audio" | "mail";
    untrusted?: true;
    quote: string | null;
    due_phrase: string | null;
    recording: { id: string; title: string } | null;
    url: string | null;
}

interface FactOut {
    id: string;
    origin: string;
    evidence?: {
        recording_id: string;
        kind: string;
        quote: string;
        quoted: boolean;
        untrusted?: true;
    }[];
}

async function call<T>(
    name: string,
    caller: McpCaller,
    args: Record<string, unknown>,
): Promise<T> {
    const definition = ALL_TOOLS.find((tool) => tool.name === name);
    if (!definition) throw new Error(`no tool ${name}`);
    const parsed = z.object(definition.input(caller)).parse(args);
    return (await definition.run(
        { caller, touched: [] },
        parsed,
    )) as unknown as T;
}

describeWithDatabase("mail through the MCP server (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let storageDir = "";
    let orgUserId = "";
    let itemId = "";
    let factId = "";
    let personId = "";
    let token = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    const jan = (roles: McpRole[]) =>
        userCaller("u-jan", "jan@company.example", roles, orgUserId);
    const READ: McpRole[] = [
        "tasks:read",
        "knowledge:read",
        "transcripts:read",
        "summaries:read",
    ];

    beforeAll(async () => {
        storageDir = mkdtempSync(path.join(tmpdir(), "riffado-mcp-mail-"));
        mockEnv.LOCAL_STORAGE_PATH = storageDir;
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_mail",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        orgUserId = (await ensureOrgAccount()) ?? "";
        await db().insert(users).values({
            id: "u-jan",
            email: "jan@company.example",
            emailVerified: true,
            lastSsoLoginAt: new Date(),
        });
        await db().insert(accounts).values({
            userId: "u-jan",
            accountId: "sub-jan",
            providerId: "oidc",
        });
        await ensureRootFolders("u-jan");
        const mailbox = await ensureMailbox("u-jan");
        await db()
            .insert(apiCredentials)
            .values({
                userId: "u-jan",
                provider: "openai",
                apiKey: encrypt("key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });
        knowledgeStore().invalidateAll();
        await seedCoreVocabulary();

        const secret = await createSecretAddress({
            userId: "u-jan",
            baseAddressId: mailbox?.id ?? "",
            label: null,
        });
        token = secret.localPart;
        const raw = await signMessage(
            rawMessage(
                [
                    // A display name carrying a secret address.
                    `From: "Jan Novotny ${secret.localPart}@klepna.example" <jan@company.example>`,
                    "To: Eva Buyer <eva@client.example>, jan@klepna.example",
                    "Subject: Contract",
                    "Date: Fri, 09 Oct 2026 14:02:00 +0200",
                    "Message-ID: <mcp-mail@company.example>",
                    "MIME-Version: 1.0",
                    "Content-Type: text/plain; charset=utf-8",
                ],
                `Petra Mala is our CFO now. Eva, please send the signed contract by Friday. File it through ${secret.localPart}@klepna.example.`,
            ),
            company,
        );
        const now = new Date();
        const facts = await authenticateMessage(raw, { resolver, now });
        await precheckMail({ recipients: ["jan@klepna.example"], facts });
        await ingestMail({
            raw,
            recipients: ["jan@klepna.example"],
            spf: "pass",
            receivedAt: now,
            resolver,
        });
        const [message] = await db()
            .select({ id: mailMessages.id })
            .from(mailMessages)
            .orderBy(desc(mailMessages.createdAt))
            .limit(1);
        itemId = message?.id ?? "";

        createCompletion.mockReset();
        createCompletion.mockResolvedValueOnce({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            summary: "Jan asks Eva for the signed contract.",
                            keyPoints: [],
                            actionItems: [
                                {
                                    text: "Send the signed contract",
                                    speaker: null,
                                    assignee: null,
                                    due: {
                                        phrase: "by Friday",
                                        date: "2026-10-09",
                                    },
                                    quote: "please send the signed contract by Friday",
                                },
                            ],
                            taskUpdates: [],
                        }),
                    },
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
        });
        await generateSummaryForRecording("u-jan", itemId);
        await acceptReview(await taskViewerById("u-jan"), itemId);

        personId = (
            await createPerson({
                userId: "u-jan",
                displayName: "Petra Mala",
                createdByUserId: "u-jan",
            })
        ).id;
        const [content] = await db()
            .select({ revision: mailContents.revision })
            .from(mailContents)
            .where(eq(mailContents.itemId, itemId));
        factId = await db().transaction((tx) =>
            confirmFactFromMailInTx(tx, {
                actorUserId: "u-jan",
                ownerUserId: "u-jan",
                itemId,
                revision: content?.revision ?? 0,
                text: { segmentIndex: 0, charStart: 0, charEnd: 25 },
                subject: { personId },
                relationKey: "has_role",
                object: { literal: "CFO" },
            }),
        );
        knowledgeStore().invalidateAll();
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        rmSync(storageDir, { recursive: true, force: true });
    }, 30_000);

    it("never shows a model a secret address", () => {
        const request = createCompletion.mock.calls[0]?.[0] as {
            messages: { role: string; content: string }[];
        };
        const sent = request.messages.map((m) => m.content).join("\n");
        expect(sent).toContain("please send the signed contract by Friday");
        expect(sent).not.toContain(token);
    });

    it("offers the mail tools only with mail:read", () => {
        const names = (roles: McpRole[]) =>
            allowedTools(ALL_TOOLS, jan(roles)).map((tool) => tool.name);
        expect(names(READ)).not.toContain("list_mail");
        expect(names(READ)).not.toContain("get_mail");
        expect(names(["mail:read"])).toEqual(
            expect.arrayContaining(["list_mail", "get_mail"]),
        );
    });

    it("lists a mail's task without mail:read, its words and its mail left out", async () => {
        const { tasks } = await call<{ tasks: TaskOut[] }>(
            "list_tasks",
            jan(READ),
            {},
        );
        const task = tasks.find(
            (row) => row.text === "Send the signed contract",
        );
        expect(task).toMatchObject({
            kind: "mail",
            untrusted: true,
            quote: null,
            due_phrase: null,
            recording: null,
            url: null,
        });
        // A word only its quote holds finds nothing.
        const hidden = await call<{ tasks: TaskOut[] }>(
            "search_tasks",
            jan(READ),
            { query: "Friday" },
        );
        expect(hidden.tasks).toEqual([]);
        const found = await call<{ tasks: TaskOut[] }>(
            "search_tasks",
            jan(READ),
            { query: "contract" },
        );
        expect(found.tasks.map((row) => row.id)).toEqual([task?.id]);
    });

    it("lists a fact from mail without mail:read, its evidence left out", async () => {
        const { facts } = await call<{ facts: FactOut[] }>(
            "get_facts",
            jan(READ),
            { entity: personId },
        );
        expect(facts).toEqual([
            expect.objectContaining({
                id: factId,
                origin: "mail",
                evidence: [],
            }),
        ]);
        const withMail = await call<{ facts: FactOut[] }>(
            "get_facts",
            jan(["knowledge:read", "mail:read"]),
            { entity: personId },
        );
        expect(withMail.facts[0]?.evidence).toEqual([
            expect.objectContaining({
                recording_id: itemId,
                kind: "mail",
                quote: "Petra Mala is our CFO now",
                quoted: false,
                untrusted: true,
            }),
        ]);
    });

    it("gives a mail's task its words and mail with mail:read", async () => {
        const { tasks } = await call<{ tasks: TaskOut[] }>(
            "list_tasks",
            jan([...READ, "mail:read"]),
            {},
        );
        expect(
            tasks.find((row) => row.text === "Send the signed contract"),
        ).toMatchObject({
            kind: "mail",
            untrusted: true,
            quote: "please send the signed contract by Friday",
            due_phrase: "by Friday",
            recording: { id: itemId, title: "Contract" },
            url: `https://riffado.example.test/dashboard?recording=${itemId}`,
        });
    });

    it("reads the pile with mail:read, secret addresses masked for their owner too", async () => {
        const caller = jan(["mail:read", "summaries:read"]);
        const listed = await call<{
            mail: { id: string; subject: string; from: unknown }[];
        }>("list_mail", caller, {});
        expect(listed.mail).toEqual([
            expect.objectContaining({
                id: itemId,
                kind: "mail",
                untrusted: true,
                subject: "Contract",
                from: {
                    name: expect.stringMatching(/^Jan Novotny jan\.•{10}@/),
                    address: "jan@company.example",
                },
            }),
        ]);
        const read = await call<{
            segments: { text: string }[];
            summary?: { summary: string | null };
        }>("get_mail", caller, { mail: itemId });
        const text = read.segments.map((segment) => segment.text).join("\n");
        expect(text).toContain("please send the signed contract by Friday");
        expect(text).toContain("jan.");
        expect(text).not.toContain(token);
        expect(read.summary?.summary).toBe(
            "Jan asks Eva for the signed contract.",
        );
        expect(
            (
                await call<{ summary?: unknown }>(
                    "get_mail",
                    jan(["mail:read"]),
                    {
                        mail: itemId,
                    },
                )
            ).summary,
        ).toBeUndefined();
    });

    it("gives a service caller the shared mail only", async () => {
        const service = serviceCaller(orgUserId, ["mail:read"]);
        expect(
            (await call<{ mail: unknown[] }>("list_mail", service, {})).mail,
        ).toEqual([]);
        await expect(
            call("get_mail", service, { mail: itemId }),
        ).rejects.toMatchObject({ outcome: "not_found" });
        const [orgRoot] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, orgUserId),
                    isNull(recordingFolders.parentId),
                ),
            );
        await addRecordingToFolder({
            userId: "u-jan",
            recordingId: itemId,
            folderId: orgRoot?.id ?? "",
        });
        expect(
            (
                await call<{ mail: { id: string }[] }>("list_mail", service, {})
            ).mail.map((mail) => mail.id),
        ).toEqual([itemId]);
    });
});
