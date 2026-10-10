/**
 * Learn on mail against a real PostgreSQL, with the provider stubbed: the
 * mail is read in parts framed as a mail, what holds is stored as review
 * items anchored in the mail's text (never a time), a quoted part's facts
 * start unticked, and a signature read once is not read again.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    accounts,
    apiCredentials,
    learnReviewItems,
    learnRuns,
    mailLearnedParts,
    mailMessages,
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("openai")>();
    return {
        ...actual,
        OpenAI: class {
            chat = { completions: { create: createCompletion } };
        },
    };
});

import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { encrypt } from "@/lib/encryption";
import { decryptJsonField } from "@/lib/encryption/fields";
import { ensureRootFolders } from "@/lib/folders/folders";
import { createEntity } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { startLearnRun } from "@/lib/learn/learn-job";
import { learnJobHandler } from "@/lib/learn/learn-job-handler";
import { ensureMailbox } from "@/lib/mail/addresses";
import { authenticateMessage } from "@/lib/mail/dkim";
import { ingestMail, precheckMail } from "@/lib/mail/ingest";
import { ensureOrgAccount } from "@/lib/org/account";
import { requireRecordingView } from "@/lib/sharing/access";
import {
    rawMessage,
    signMessage,
    testResolver,
    testSigner,
} from "@/tests/mail/dkim-fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const company = testSigner("company.example");
const resolver = testResolver([company]);

const BODY = [
    "Petra Mala leads the pilot at Acme.",
    "",
    "Best regards,",
    "Jan Novotny",
    "Head of Sales",
    "",
    "On Thu, 8 Oct 2026 at 17:40, Eva Buyer <eva@client.example> wrote:",
    "> I work for Globex now.",
].join("\n");

function reply(content: object) {
    return {
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
}

describeWithDatabase("Learn on mail (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let storageDir = "";
    let acmeId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function deliver(subject: string, body: string): Promise<string> {
        const raw = await signMessage(
            rawMessage(
                [
                    "From: Jan Novotny <jan@company.example>",
                    "To: Eva Buyer <eva@client.example>, jan@klepna.example",
                    `Subject: ${subject}`,
                    "Date: Fri, 09 Oct 2026 14:02:00 +0200",
                    `Message-ID: <${Math.random().toString(36).slice(2)}@company.example>`,
                    "MIME-Version: 1.0",
                    "Content-Type: text/plain; charset=utf-8",
                ],
                body,
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
            .where(eq(mailMessages.sizeBytes, raw.length));
        if (!message) throw new Error("mail not stored");
        return message.id;
    }

    async function learn(itemId: string) {
        const access = await requireRecordingView("u-jan", itemId, "private", {
            kinds: ALL_ITEM_KINDS,
        });
        const { runId } = await startLearnRun({
            access,
            actorUserId: "u-jan",
            source: "riffado",
            trigger: "manual",
        });
        const result = await learnJobHandler.run({
            payload: { runId },
            userId: "u-jan",
            jobId: "job",
            attempt: 1,
            maxAttempts: 2,
            signal: new AbortController().signal,
            reportProgress: () => {},
        });
        return { runId, result };
    }

    beforeAll(async () => {
        storageDir = mkdtempSync(join(tmpdir(), "riffado-mail-learn-"));
        mockEnv.LOCAL_STORAGE_PATH = storageDir;
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mail_learn",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        await ensureOrgAccount();
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
        await ensureMailbox("u-jan");
        // No automatic processing: the runs here are started by hand.
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
        acmeId = (
            await createEntity("u-jan", {
                typeKey: "organization",
                name: "Acme",
            })
        ).id;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        rmSync(storageDir, { recursive: true, force: true });
    }, 30_000);

    it("reads a mail in parts and stores review items at their place in its text", async () => {
        const itemId = await deliver("Pilot", BODY);
        createCompletion.mockReset();
        createCompletion
            .mockResolvedValueOnce(
                reply({
                    mentions: [
                        { text: "Acme", turn: 0, forms: [] },
                        { text: "Petra Mala", turn: 0, forms: [] },
                        { text: "Globex", turn: 2, forms: [] },
                    ],
                }),
            )
            .mockResolvedValueOnce(
                reply({
                    newRecords: [
                        {
                            ref: "n1",
                            kind: "person",
                            typeKey: null,
                            name: "Petra Mala",
                            speakerLabel: null,
                            evidence: ["00:00"],
                            reason: "Named with her surname",
                        },
                        {
                            ref: "n2",
                            kind: "entity",
                            typeKey: "organization",
                            name: "Globex",
                            speakerLabel: null,
                            evidence: ["02:00"],
                            reason: "An organization",
                        },
                    ],
                    speakers: [],
                    corrections: [],
                    facts: [
                        {
                            subject: { newRef: "n1" },
                            relationKey: "works_for",
                            object: { entityId: acmeId },
                            start: "00:00",
                            end: "00:00",
                            speakerLabel: null,
                            sensitivity: "none",
                        },
                        {
                            subject: { speakerLabel: "p2" },
                            relationKey: "works_for",
                            object: { newRef: "n2" },
                            start: "02:00",
                            end: "02:00",
                            speakerLabel: "p2",
                            sensitivity: "none",
                        },
                    ],
                    relationPhrases: [],
                }),
            );

        const { runId, result } = await learn(itemId);
        expect(result).toMatchObject({ status: "ready" });

        const answer = createCompletion.mock.calls[1]?.[0] as {
            messages: { role: string; content: string }[];
        };
        const system = answer.messages.find((m) => m.role === "system");
        const user = answer.messages.find((m) => m.role === "user");
        expect(system?.content).toContain("You get a mail in parts");
        expect(user?.content).toContain("MAIL:");
        expect(user?.content).toContain("Petra Mala leads the pilot at Acme.");
        expect(user?.content).toContain("(quoted");
        expect(user?.content).not.toContain("jan@company.example");

        const items = (
            await db()
                .select()
                .from(learnReviewItems)
                .where(eq(learnReviewItems.runId, runId))
        ).map((row) => ({
            kind: row.kind,
            preTicked: row.preTicked,
            payload: decryptJsonField<Record<string, unknown>>(row.payload),
        }));
        // Nothing past the run sees a time.
        expect(JSON.stringify(items)).not.toContain("startMs");
        expect(JSON.stringify(items)).not.toContain("evidenceMs");
        const petra = items.find(
            (item) =>
                item.kind === "new_record" &&
                item.payload?.name === "Petra Mala",
        );
        expect(petra?.payload?.evidence).toEqual([
            { segmentIndex: 0, charStart: 0, charEnd: 35 },
        ]);
        const facts = items.filter((item) => item.kind === "fact");
        const pilot = facts.find(
            (item) =>
                (item.payload?.text as { segmentIndex: number })
                    .segmentIndex === 0,
        );
        expect(pilot?.payload?.provenance).toBeNull();
        const quoted = facts.find(
            (item) => item.payload?.provenance === "quoted",
        );
        expect(quoted?.preTicked).toBe(false);
        expect(quoted?.payload?.text).toMatchObject({ segmentIndex: 2 });

        const learned = await db()
            .select({ itemId: mailLearnedParts.itemId })
            .from(mailLearnedParts);
        expect(learned.map((row) => row.itemId)).toContain(itemId);
    });

    it("does not read a signature it has read in another mail", async () => {
        const itemId = await deliver(
            "Pilot, again",
            BODY.replace("Petra Mala leads", "Petra Mala still leads"),
        );
        createCompletion.mockReset();
        createCompletion
            .mockResolvedValueOnce(reply({ mentions: [] }))
            .mockResolvedValueOnce(
                reply({
                    newRecords: [],
                    speakers: [],
                    corrections: [],
                    facts: [],
                    relationPhrases: [],
                }),
            );
        const { result } = await learn(itemId);
        expect(result).toMatchObject({ status: "finished" });
        const answer = createCompletion.mock.calls[1]?.[0] as {
            messages: { role: string; content: string }[];
        };
        const user = answer.messages.find((m) => m.role === "user");
        expect(user?.content).toContain("Petra Mala still leads");
        expect(user?.content).not.toContain("Head of Sales");
        const [run] = await db()
            .select({ transcriptionId: learnRuns.transcriptionId })
            .from(learnRuns)
            .where(eq(learnRuns.itemId, itemId));
        expect(run?.transcriptionId).toBeNull();
    });
});
