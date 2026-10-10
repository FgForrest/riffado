/**
 * Summaries and task proposals of mail against a real PostgreSQL, with the
 * provider stubbed: what the model is shown (references and domains in the
 * user message, nothing of the mail in the system message), what is stored
 * (a summary without a transcript), and how task evidence is placed and
 * trusted (a quoted part or an unverified sender starts unticked).
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    accounts,
    aiEnhancements,
    apiCredentials,
    asyncJobs,
    mailMessages,
    mailParticipants,
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

import { CONTENT_IS_DATA_DIRECTIVE } from "@/lib/ai/content-directive";
import { readItemContent } from "@/lib/content/read-item-content";
import { renderMailForModel } from "@/lib/content/render-mail";
import { encrypt } from "@/lib/encryption";
import { decryptText } from "@/lib/encryption/fields";
import { ensureRootFolders } from "@/lib/folders/folders";
import { createPerson } from "@/lib/knowledge/people";
import { ensureMailbox } from "@/lib/mail/addresses";
import { collectArchivedMail } from "@/lib/mail/archive";
import { authenticateMessage } from "@/lib/mail/dkim";
import { ingestMail, precheckMail } from "@/lib/mail/ingest";
import { ensureOrgAccount } from "@/lib/org/account";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { parseSummaryJobPayload } from "@/lib/summary/summary-job";
import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import { taskViewerById } from "@/lib/tasks/access";
import { tasksForArchive } from "@/lib/tasks/archive";
import {
    acceptReview,
    listRecordingTasks,
    listTasks,
    recordingsAwaitingTaskReview,
} from "@/lib/tasks/tasks";
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
    "Eva, please send the signed contract by Friday.",
    "",
    "Best regards,",
    "Jan Novotny",
    "",
    "On Thu, 8 Oct 2026 at 17:40, Eva Buyer <eva@client.example> wrote:",
    "> We will deliver the samples to your warehouse next week.",
].join("\n");

function reply(content: object) {
    return {
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
}

describeWithDatabase("summaries of mail (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let storageDir = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function deliver(raw: Buffer, recipients: string[]): Promise<string> {
        const now = new Date();
        const facts = await authenticateMessage(raw, { resolver, now });
        const precheck = await precheckMail({ recipients, facts });
        expect(precheck.accepted).toEqual(recipients);
        await ingestMail({
            raw,
            recipients,
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

    function headers(subject: string, extra: string[] = []) {
        return [
            "From: Jan Novotny <jan@company.example>",
            "To: Eva Buyer <eva@client.example>, jan@klepna.example",
            `Subject: ${subject}`,
            "Date: Fri, 09 Oct 2026 14:02:00 +0200",
            `Message-ID: <${Math.random().toString(36).slice(2)}@company.example>`,
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            ...extra,
        ];
    }

    beforeAll(async () => {
        storageDir = mkdtempSync(join(tmpdir(), "riffado-mail-summary-"));
        mockEnv.LOCAL_STORAGE_PATH = storageDir;
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mail_summary",
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
        await db()
            .insert(apiCredentials)
            .values({
                userId: "u-jan",
                provider: "openai",
                apiKey: encrypt("key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        rmSync(storageDir, { recursive: true, force: true });
    }, 30_000);

    it("reads a mail as content: participants by reference, segments by role", async () => {
        const itemId = await deliver(
            await signMessage(rawMessage(headers("Contract"), BODY), company),
            ["jan@klepna.example"],
        );
        const content = await readItemContent("u-jan", itemId);
        expect(content?.kind).toBe("mail");
        expect(content?.segments.map((segment) => segment.role)).toEqual([
            "body",
            "signature",
            "quoted",
        ]);
        expect(
            content?.participants.find((participant) =>
                participant.roles.includes("from"),
            ),
        ).toMatchObject({ displayName: "Jan Novotny", authenticated: true });
        expect(await readItemContent("u-other", itemId)).toBeNull();
    });

    it("reads a reply's quote of a mail in the pile once, and knows its people", async () => {
        const person = await createPerson({
            userId: "u-jan",
            displayName: "Eva Buyer",
            primaryEmail: "Eva@Client.example",
        });
        const original = await deliver(
            await signMessage(
                rawMessage(
                    [
                        ...headers("Delivery").filter(
                            (line) => !line.startsWith("Message-ID"),
                        ),
                        "Message-ID: <first-1@company.example>",
                    ],
                    "Can you deliver in November?",
                ),
                company,
            ),
            ["jan@klepna.example"],
        );
        const reply = await deliver(
            await signMessage(
                rawMessage(
                    [
                        ...headers("Re: Delivery").filter(
                            (line) => !line.startsWith("Message-ID"),
                        ),
                        "Message-ID: <reply-1@company.example>",
                        "In-Reply-To: <first-1@company.example>",
                        "References: <first-1@company.example>",
                    ],
                    [
                        "November works for us.",
                        "",
                        "On Fri, 9 Oct 2026 at 14:02, Jan Novotny <jan@company.example> wrote:",
                        "> Can you deliver in November?",
                    ].join("\n"),
                ),
                company,
            ),
            ["jan@klepna.example"],
        );
        const content = await readItemContent("u-jan", reply);
        const quoted = content?.segments.find(
            (segment) => segment.role === "quoted",
        );
        expect(quoted?.knownItemId).toBe(original);
        const shown = renderMailForModel(
            content ?? { participants: [], segments: [] },
            {
                subject: "Re: Delivery",
                sentAt: null,
            },
        );
        expect(shown).toContain("November works for us.");
        expect(shown).not.toContain("Can you deliver in November?");

        const [eva] = await db()
            .select({ personId: mailParticipants.personId })
            .from(mailParticipants)
            .where(
                and(
                    eq(mailParticipants.itemId, reply),
                    eq(mailParticipants.ref, "p2"),
                ),
            );
        expect(eva?.personId).toBe(person.id);
    });

    it("summarizes a mail and proposes its tasks, quoted ones unticked", async () => {
        const itemId = await deliver(
            await signMessage(
                rawMessage(headers("Contract and samples"), BODY),
                company,
            ),
            ["jan@klepna.example"],
        );
        createCompletion.mockReset();
        createCompletion.mockResolvedValueOnce(
            reply({
                summary: "Jan asks Eva for the signed contract by Friday.",
                keyPoints: ["Samples arrive next week"],
                actionItems: [
                    {
                        text: "Send the signed contract",
                        speaker: "p2",
                        assignee: null,
                        due: { phrase: "by Friday", date: "2026-10-09" },
                        quote: "please send the signed contract by Friday",
                    },
                    {
                        text: "Deliver the samples to the warehouse",
                        speaker: null,
                        assignee: "Eva Buyer",
                        due: null,
                        quote: "deliver the samples to your warehouse next week",
                    },
                ],
                taskUpdates: [],
            }),
        );

        const result = await generateSummaryForRecording("u-jan", itemId);
        expect(result).toMatchObject({
            ownerUserId: "u-jan",
            promptId: "mail",
            summary: "Jan asks Eva for the signed contract by Friday.",
        });

        const request = createCompletion.mock.calls[0]?.[0] as {
            messages: { role: string; content: string }[];
        };
        const system = request.messages.find((m) => m.role === "system");
        const user = request.messages.find((m) => m.role === "user");
        expect(system?.content).toContain(CONTENT_IS_DATA_DIRECTIVE);
        expect(system?.content).not.toContain("Novotny");
        expect(system?.content).not.toContain("Contract and samples");
        expect(user?.content).toContain("[#0 body p1]");
        expect(user?.content).toContain("company.example");
        expect(user?.content).not.toContain("jan@company.example");
        expect(user?.content).not.toContain("eva@client.example");
        expect(user?.content).toContain("The mail was sent on");

        const [stored] = await db()
            .select()
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, itemId),
                    eq(aiEnhancements.userId, "u-jan"),
                ),
            );
        expect(stored?.transcriptionId).toBeNull();
        expect(decryptText(stored?.summary ?? "")).toBe(
            "Jan asks Eva for the signed contract by Friday.",
        );

        const tasks = await db()
            .select()
            .from(recordingTasks)
            .where(eq(recordingTasks.itemId, itemId));
        const byText = new Map(
            tasks.map((task) => [decryptText(task.text), task]),
        );
        const contract = byText.get("Send the signed contract");
        expect(contract).toMatchObject({
            status: "proposed",
            ticked: true,
            evidenceStartMs: null,
            evidenceSegmentIndex: 0,
            evidenceProvenance: null,
            dueDate: "2026-10-09",
        });
        // Eva's address is a person of Jan's Almanac since the test above.
        expect(contract?.assigneePersonId).toEqual(expect.any(String));
        expect(contract?.assigneeCheck).toBe(false);
        const samples = byText.get("Deliver the samples to the warehouse");
        expect(samples).toMatchObject({
            ticked: false,
            evidenceSegmentIndex: 2,
            evidenceProvenance: "quoted",
        });
        const content = await readItemContent("u-jan", itemId);
        const quoted = content?.segments[2]?.text ?? "";
        expect(
            quoted.slice(
                samples?.evidenceCharStart ?? 0,
                samples?.evidenceCharEnd ?? 0,
            ),
        ).toBe("deliver the samples to your warehouse next week");
    });

    it("reviews a mail's tasks like a recording's, and backs them up with its summary", async () => {
        const viewer = await taskViewerById("u-jan");
        const waiting = await recordingsAwaitingTaskReview(viewer);
        const [entry] = waiting.filter(
            (row) => row.title === "Contract and samples",
        );
        expect(entry?.proposals).toBe(2);
        const itemId = entry?.recordingId ?? "";

        const listed = await listRecordingTasks(viewer, itemId);
        expect(listed?.canEdit).toBe(true);
        expect(listed?.proposals).toHaveLength(2);
        const quoted = listed?.proposals.find(
            (task) => task.evidenceProvenance === "quoted",
        );
        expect(quoted?.evidenceText).toMatchObject({ segmentIndex: 2 });

        const result = await acceptReview(viewer, itemId);
        expect(result).toMatchObject({ accepted: 1, rejected: 1 });
        const tasks = await listTasks(viewer, {
            tab: "tracked",
            state: "open",
            folderId: null,
            due: null,
            today: null,
            sort: "created",
        });
        const contract = tasks.find(
            (task) => task.text === "Send the signed contract",
        );
        expect(contract?.recording).toMatchObject({
            id: itemId,
            kind: "mail",
            view: "private",
            title: "Contract and samples",
        });
        expect(
            await listRecordingTasks(await taskViewerById("u-other"), itemId),
        ).toBeNull();

        const [archived] = (
            await collectArchivedMail({ kind: "personal", userId: "u-jan" })
        ).filter((mail) => mail.id === itemId);
        expect(archived?.summaries[0]?.summary).toBe(
            "Jan asks Eva for the signed contract by Friday.",
        );
        const archivedTasks = await tasksForArchive(
            { kind: "personal", userId: "u-jan" },
            [itemId],
            { proposals: true },
        );
        expect(archivedTasks.get(itemId)?.[0]).toMatchObject({
            text: "Send the signed contract",
            status: "open",
            evidenceText: { segmentIndex: 0 },
        });
    });

    it("queues a summary of new mail, unless machine-sent or switched off", async () => {
        const queued = async (itemId: string) =>
            (
                await db()
                    .select({ payload: asyncJobs.payload })
                    .from(asyncJobs)
                    .where(
                        and(
                            eq(asyncJobs.kind, "summary"),
                            eq(asyncJobs.userId, "u-jan"),
                        ),
                    )
            ).filter(
                (job) =>
                    (job.payload as { recordingId?: string }).recordingId ===
                    itemId,
            );
        const plain = await deliver(
            await signMessage(
                rawMessage(headers("Plain"), "Please call me."),
                company,
            ),
            ["jan@klepna.example"],
        );
        expect(await queued(plain)).toHaveLength(1);
        const machine = await deliver(
            await signMessage(
                rawMessage(headers("Notice", ["Precedence: bulk"]), "News."),
                company,
            ),
            ["jan@klepna.example"],
        );
        expect(await queued(machine)).toHaveLength(0);
        await db()
            .insert(userSettings)
            .values({ userId: "u-jan", mailAutoProcess: false })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: { mailAutoProcess: false },
            });
        const off = await deliver(
            await signMessage(
                rawMessage(headers("Later"), "Not now."),
                company,
            ),
            ["jan@klepna.example"],
        );
        expect(await queued(off)).toHaveLength(0);
    });

    it("runs a queued mail summary on the worker's path", async () => {
        await db()
            .update(userSettings)
            .set({ mailAutoProcess: true })
            .where(eq(userSettings.userId, "u-jan"));
        const itemId = await deliver(
            await signMessage(
                rawMessage(headers("Worker"), "Please confirm the date."),
                company,
            ),
            ["jan@klepna.example"],
        );
        const [job] = (
            await db()
                .select()
                .from(asyncJobs)
                .where(
                    and(
                        eq(asyncJobs.kind, "summary"),
                        eq(asyncJobs.userId, "u-jan"),
                    ),
                )
        ).filter(
            (row) =>
                (row.payload as { recordingId?: string }).recordingId ===
                itemId,
        );
        if (!job) throw new Error("no queued job");
        // As the worker claims it.
        await db()
            .update(asyncJobs)
            .set({ status: "processing" })
            .where(eq(asyncJobs.id, job.id));
        createCompletion.mockReset();
        createCompletion.mockResolvedValueOnce(
            reply({
                summary: "Jan asks for the date to be confirmed.",
                keyPoints: [],
                actionItems: [],
                taskUpdates: [],
            }),
        );
        const result = await summaryJobHandler.run({
            jobId: job.id,
            userId: "u-jan",
            attempt: 1,
            maxAttempts: 3,
            payload: parseSummaryJobPayload(job.payload),
            signal: new AbortController().signal,
            reportProgress: () => undefined,
        });
        expect(result).toMatchObject({ promptId: "mail" });
        const [stored] = await db()
            .select({ summary: aiEnhancements.summary })
            .from(aiEnhancements)
            .where(eq(aiEnhancements.itemId, itemId));
        expect(decryptText(stored?.summary ?? "")).toBe(
            "Jan asks for the date to be confirmed.",
        );
    });

    it("never summarizes mail sent by machines", async () => {
        const itemId = await deliver(
            await signMessage(
                rawMessage(
                    headers("Out of office", ["Auto-Submitted: auto-replied"]),
                    "I am away.",
                ),
                company,
            ),
            ["jan@klepna.example"],
        );
        createCompletion.mockReset();
        await expect(
            generateSummaryForRecording("u-jan", itemId),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(createCompletion).not.toHaveBeenCalled();
    });
});
