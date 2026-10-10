/**
 * Mail retention against a real PostgreSQL: each part of a mail goes on
 * its own period counted from when it arrived, the facts only its text
 * said go with the text (D5), a shared mail is the Organization's policy's
 * alone, and the mail stays in the pile marked with what went.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    accounts,
    aiEnhancements,
    apiCredentials,
    chatterItems,
    knowledgeFactEvidence,
    knowledgeFacts,
    mailContents,
    mailLearnedParts,
    mailMessages,
    mailParticipants,
    recordingFolders,
    recordingTasks,
    userSettings,
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

import {
    countMailReapCandidates,
    listArmedMailRetentionPolicies,
    listMailReapCandidates,
    type MailRetentionPolicy,
} from "@/db/queries/mail-retention";
import { encrypt } from "@/lib/encryption";
import { addRecordingToFolder, ensureRootFolders } from "@/lib/folders/folders";
import { confirmFactFromMailInTx } from "@/lib/knowledge/facts";
import { createPerson } from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureMailbox } from "@/lib/mail/addresses";
import { loadMailDetail } from "@/lib/mail/detail";
import { authenticateMessage } from "@/lib/mail/dkim";
import { ingestMail, precheckMail } from "@/lib/mail/ingest";
import { ensureOrgAccount } from "@/lib/org/account";
import { reapMail } from "@/lib/retention/reap-mail";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
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
const DAY_MS = 24 * 60 * 60 * 1000;

describeWithDatabase("mail retention (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let storageDir = "";
    let orgUserId = "";

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
            .orderBy(desc(mailMessages.createdAt))
            .limit(1);
        if (!message) throw new Error("mail not stored");
        return message.id;
    }

    /** As if it arrived `days` ago. */
    async function age(itemId: string, days: number) {
        await db()
            .update(mailMessages)
            .set({ receivedAt: new Date(Date.now() - days * DAY_MS) })
            .where(eq(mailMessages.id, itemId));
    }

    async function summarize(itemId: string) {
        createCompletion.mockReset();
        createCompletion.mockResolvedValueOnce({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            summary: "Jan asks for the contract.",
                            keyPoints: [],
                            actionItems: [
                                {
                                    text: "Send the contract",
                                    speaker: null,
                                    assignee: null,
                                    due: null,
                                    quote: null,
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
    }

    async function mailFact(itemId: string): Promise<string> {
        const person = await createPerson({
            userId: "u-jan",
            displayName: `Petra ${itemId.slice(0, 4)}`,
            createdByUserId: "u-jan",
        });
        const [content] = await db()
            .select({ revision: mailContents.revision })
            .from(mailContents)
            .where(eq(mailContents.itemId, itemId));
        return db().transaction((tx) =>
            confirmFactFromMailInTx(tx, {
                actorUserId: "u-jan",
                ownerUserId: "u-jan",
                itemId,
                revision: content?.revision ?? 0,
                text: { segmentIndex: 0, charStart: 0, charEnd: 10 },
                subject: { personId: person.id },
                relationKey: "has_role",
                object: { literal: "CFO" },
            }),
        );
    }

    const policy = (
        days: Partial<Omit<MailRetentionPolicy, "userId">>,
        userId = "u-jan",
    ): MailRetentionPolicy => ({
        userId,
        rawDays: null,
        contentDays: null,
        summaryDays: null,
        ...days,
    });

    beforeAll(async () => {
        storageDir = mkdtempSync(
            path.join(tmpdir(), "riffado-mail-retention-"),
        );
        mockEnv.LOCAL_STORAGE_PATH = storageDir;
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mail_retention",
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
        await ensureMailbox("u-jan");
        await db()
            .insert(apiCredentials)
            .values({
                userId: "u-jan",
                provider: "openai",
                apiKey: encrypt("key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });
        await seedCoreVocabulary();
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        rmSync(storageDir, { recursive: true, force: true });
    }, 30_000);

    it("ages a mail from when it arrived, never from the date its sender wrote", async () => {
        // The Date header is weeks old; the mail arrived today.
        const itemId = await deliver("Fresh", "Please send the contract.");
        const now = new Date();
        expect(
            (
                await listMailReapCandidates(
                    policy({ rawDays: 1 }),
                    now,
                    50,
                    orgUserId,
                )
            ).map((mail) => mail.id),
        ).not.toContain(itemId);
        await age(itemId, 2);
        expect(
            (
                await listMailReapCandidates(
                    policy({ rawDays: 1 }),
                    now,
                    50,
                    orgUserId,
                )
            ).map((mail) => mail.id),
        ).toContain(itemId);
    });

    it("removes the message, then the text with the facts only it said, then the summary", async () => {
        const itemId = await deliver(
            "Contract",
            "Petra Mala is our CFO now. Please send the contract.",
        );
        await summarize(itemId);
        const factId = await mailFact(itemId);
        // A signature Learn read in this mail.
        await db()
            .insert(mailLearnedParts)
            .values({ userId: "u-jan", fingerprint: "f".repeat(64), itemId });
        await age(itemId, 40);
        const [stored] = await db()
            .select({ path: mailMessages.rawStoragePath })
            .from(mailMessages)
            .where(eq(mailMessages.id, itemId));
        const file = path.join(storageDir, stored?.path ?? "missing");
        expect(existsSync(file)).toBe(true);

        const now = new Date();
        const every = policy({ rawDays: 30, contentDays: 30, summaryDays: 30 });
        expect(
            await countMailReapCandidates(every, now.getTime(), orgUserId),
        ).toBeGreaterThanOrEqual(1);
        const [candidate] = (
            await listMailReapCandidates(every, now, 50, orgUserId)
        ).filter((mail) => mail.id === itemId);
        if (!candidate) throw new Error("not a candidate");
        const outcome = await reapMail(every, candidate, now, orgUserId);
        expect(outcome.failed).toEqual({});
        expect(outcome.reaped.sort()).toEqual(["content", "raw", "summary"]);

        expect(existsSync(file)).toBe(false);
        const [message] = await db()
            .select({
                path: mailMessages.rawStoragePath,
                rawReapedAt: mailMessages.rawReapedAt,
            })
            .from(mailMessages)
            .where(eq(mailMessages.id, itemId));
        expect(message?.path).toBeNull();
        expect(message?.rawReapedAt).toBeInstanceOf(Date);
        expect(
            await db()
                .select()
                .from(mailContents)
                .where(eq(mailContents.itemId, itemId)),
        ).toEqual([]);
        // D5: the fact said only here goes with its text.
        expect(
            await db()
                .select()
                .from(knowledgeFactEvidence)
                .where(eq(knowledgeFactEvidence.itemId, itemId)),
        ).toEqual([]);
        expect(
            await db()
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.id, factId)),
        ).toEqual([]);
        // Its signature is read again in the next mail that has it.
        expect(
            await db()
                .select()
                .from(mailLearnedParts)
                .where(eq(mailLearnedParts.itemId, itemId)),
        ).toEqual([]);
        expect(
            await db()
                .select()
                .from(aiEnhancements)
                .where(eq(aiEnhancements.itemId, itemId)),
        ).toEqual([]);
        expect(
            await db()
                .select()
                .from(recordingTasks)
                .where(eq(recordingTasks.itemId, itemId)),
        ).toEqual([]);
        // Still in the pile: who wrote it to whom, and what went.
        expect(
            (
                await db()
                    .select()
                    .from(mailParticipants)
                    .where(eq(mailParticipants.itemId, itemId))
            ).length,
        ).toBeGreaterThan(0);
        const detail = await loadMailDetail("u-jan", itemId);
        expect(detail).toMatchObject({
            subject: "Contract",
            hasRaw: false,
            segments: [],
            rawReapedAt: expect.any(String),
            contentReapedAt: expect.any(String),
            summaryReapedAt: expect.any(String),
        });
        // Done: the next sweep finds nothing left of it.
        expect(
            (await listMailReapCandidates(every, now, 50, orgUserId)).map(
                (mail) => mail.id,
            ),
        ).not.toContain(itemId);
    });

    it("leaves a shared mail to the Organization's policy alone", async () => {
        const itemId = await deliver("Shared", "For the whole team.");
        await age(itemId, 40);
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
        const now = new Date();
        const own = policy({ rawDays: 30 });
        expect(
            (await listMailReapCandidates(own, now, 50, orgUserId)).map(
                (mail) => mail.id,
            ),
        ).not.toContain(itemId);

        const organization = {
            ...policy({ rawDays: 30 }, orgUserId),
            isOrg: true,
        };
        const [candidate] = (
            await listMailReapCandidates(organization, now, 50, orgUserId)
        ).filter((mail) => mail.id === itemId);
        expect(candidate?.userId).toBe("u-jan");
        if (!candidate) throw new Error("not a candidate");
        // The owner's policy, choosing it anyway, is refused under the lock.
        expect((await reapMail(own, candidate, now, orgUserId)).reaped).toEqual(
            [],
        );
        expect(
            (await reapMail(organization, candidate, now, orgUserId)).reaped,
        ).toEqual(["raw"]);
        const [item] = await db()
            .select({ deletedAt: chatterItems.deletedAt })
            .from(chatterItems)
            .where(eq(chatterItems.id, itemId));
        expect(item?.deletedAt).toBeNull();
    });

    it("arms only accounts with a mail period, the Organization's first", async () => {
        for (const [userId, values] of [
            ["u-jan", { retentionMailContentDays: 30 }],
            [orgUserId, { retentionMailRawDays: 60 }],
        ] as const) {
            await db()
                .insert(userSettings)
                .values({ userId, ...values })
                .onConflictDoUpdate({
                    target: userSettings.userId,
                    set: values,
                });
        }
        const policies = await listArmedMailRetentionPolicies(10);
        expect(policies[0]).toMatchObject({
            userId: orgUserId,
            rawDays: 60,
            isOrg: true,
        });
        expect(policies).toContainEqual(
            expect.objectContaining({
                userId: "u-jan",
                contentDays: 30,
                isOrg: false,
            }),
        );
    });
});
