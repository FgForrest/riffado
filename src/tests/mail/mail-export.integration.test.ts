/**
 * Mail in folder exports against a real PostgreSQL, written to a scratch
 * filesystem export root: a mail becomes its message as it arrived and a
 * Markdown document rendered when written, only when the export asks for
 * mail; the Organization's export writes the document alone, its secret
 * addresses masked; deleting the mail takes what the export wrote.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    accounts,
    apiCredentials,
    folderExportMaterializations,
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
            FILESYSTEM_EXPORT_ROOT: "",
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
import { createFolderExport } from "@/lib/folder-exports/configurations";
import { materializeFolderExport } from "@/lib/folder-exports/execution";
import { planFolderExport } from "@/lib/folder-exports/planner";
import {
    addRecordingToFolder,
    createFolder,
    ensureRootFolders,
} from "@/lib/folders/folders";
import { createSecretAddress, ensureMailbox } from "@/lib/mail/addresses";
import { authenticateMessage } from "@/lib/mail/dkim";
import { ingestMail, precheckMail } from "@/lib/mail/ingest";
import { deleteMail } from "@/lib/mail/manage";
import { ensureOrgAccount } from "@/lib/org/account";
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

const BODY = [
    "Eva, please send the signed contract by Friday.",
    "",
    "On Thu, 8 Oct 2026 at 17:40, Eva Buyer <eva@client.example> wrote:",
    "> We will deliver the samples to your warehouse next week.",
].join("\n");

/** Every file under `root`, relative and sorted. */
function filesUnder(root: string): string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
            path.relative(root, path.join(entry.parentPath, entry.name)),
        )
        .sort();
}

describeWithDatabase("mail in folder exports (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let storageDir = "";
    let orgUserId = "";
    let privateRootId = "";
    let mailboxId = "";
    let firstMail = "";
    let firstRaw: Buffer = Buffer.alloc(0);

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function deliver(subject: string, body: string, cc: string[] = []) {
        const raw = await signMessage(
            rawMessage(
                [
                    "From: Jan Novotny <jan@company.example>",
                    "To: Eva Buyer <eva@client.example>, jan@klepna.example",
                    ...cc.map((address) => `Cc: ${address}`),
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
        return { id: message.id, raw };
    }

    async function exportNow(userId: string, exportId: string) {
        await planFolderExport(userId, exportId);
        const states = await db()
            .select({
                id: folderExportMaterializations.id,
                status: folderExportMaterializations.status,
            })
            .from(folderExportMaterializations)
            .where(
                and(
                    eq(folderExportMaterializations.userId, userId),
                    eq(
                        folderExportMaterializations.exportConfigurationId,
                        exportId,
                    ),
                    eq(folderExportMaterializations.expected, true),
                ),
            );
        for (const state of states) {
            if (state.status !== "exported") {
                await materializeFolderExport(userId, state.id);
            }
        }
    }

    beforeAll(async () => {
        storageDir = mkdtempSync(path.join(tmpdir(), "riffado-mail-export-"));
        mockEnv.LOCAL_STORAGE_PATH = path.join(storageDir, "storage");
        mockEnv.FILESYSTEM_EXPORT_ROOT = path.join(storageDir, "exports");
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mail_export",
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
        mailboxId = (await ensureMailbox("u-jan"))?.id ?? "";
        await db()
            .insert(apiCredentials)
            .values({
                userId: "u-jan",
                provider: "openai",
                apiKey: encrypt("key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, "u-jan"),
                    eq(recordingFolders.kind, "private"),
                    isNull(recordingFolders.parentId),
                ),
            );
        privateRootId = root?.id ?? "";
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        rmSync(storageDir, { recursive: true, force: true });
    }, 30_000);

    it("writes a mail as its message and a Markdown document, mail only", async () => {
        const delivered = await deliver("Contract", BODY);
        firstMail = delivered.id;
        firstRaw = delivered.raw;
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
                                    due: null,
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
        await generateSummaryForRecording("u-jan", firstMail);

        const configuration = await createFolderExport("u-jan", privateRootId, {
            provider: "filesystem",
            targetPath: "mine",
            exportAudio: false,
            exportTranscript: false,
            exportSummary: false,
            exportMail: true,
        });
        expect(configuration.exportMail).toBe(true);
        await exportNow("u-jan", configuration.id);

        const root = mockEnv.FILESYSTEM_EXPORT_ROOT;
        expect(filesUnder(root)).toEqual([
            "mine/Contract/mail.md",
            "mine/Contract/message.eml",
        ]);
        expect(
            readFileSync(path.join(root, "mine/Contract/message.eml")),
        ).toEqual(firstRaw);
        const document = readFileSync(
            path.join(root, "mine/Contract/mail.md"),
            "utf8",
        );
        expect(document).toContain('title: "Contract"');
        expect(document).toContain("# Contract");
        expect(document).toContain(
            "**From:** Jan Novotny <jan@company.example>",
        );
        expect(document).toContain(
            "Eva, please send the signed contract by Friday.",
        );
        expect(document).toContain(
            "> We will deliver the samples to your warehouse next week.",
        );
        expect(document).toContain("## Summary");
        expect(document).toContain("Jan asks Eva for the signed contract.");
    });

    it("leaves mail out of an export that does not ask for it", async () => {
        const configuration = await createFolderExport("u-jan", privateRootId, {
            provider: "filesystem",
            targetPath: "recordings-only",
            exportAudio: true,
            exportTranscript: true,
            exportSummary: true,
        });
        expect(configuration.exportMail).toBe(false);
        await exportNow("u-jan", configuration.id);
        expect(
            filesUnder(
                path.join(mockEnv.FILESYSTEM_EXPORT_ROOT, "recordings-only"),
            ),
        ).toEqual([]);
    });

    it("writes the Organization's export without the message, secret addresses masked", async () => {
        const secret = await createSecretAddress({
            userId: "u-jan",
            baseAddressId: mailboxId,
            label: null,
        });
        const secretAddress = `${secret.localPart}@klepna.example`;
        const shared = await deliver(
            "Archive",
            `Filed through ${secretAddress} for the archive.`,
            [secretAddress],
        );
        const [orgRoot] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, orgUserId),
                    isNull(recordingFolders.parentId),
                ),
            );
        const folder = await createFolder({
            userId: "u-jan",
            parentId: orgRoot?.id ?? "",
            name: "Archive",
        });
        await addRecordingToFolder({
            userId: "u-jan",
            recordingId: shared.id,
            folderId: folder.id,
        });

        const configuration = await createFolderExport(
            orgUserId,
            orgRoot?.id ?? "",
            {
                provider: "filesystem",
                targetPath: "org",
                exportAudio: false,
                exportTranscript: false,
                exportSummary: false,
                exportMail: true,
            },
        );
        await exportNow(orgUserId, configuration.id);

        const root = path.join(mockEnv.FILESYSTEM_EXPORT_ROOT, "org");
        expect(filesUnder(root)).toEqual(["Archive/Archive/mail.md"]);
        const document = readFileSync(
            path.join(root, "Archive/Archive/mail.md"),
            "utf8",
        );
        expect(document).toContain("Filed through jan.");
        expect(document).not.toContain(secret.localPart);
    });

    it("takes what it wrote of a mail when the mail is deleted", async () => {
        const [configuration] = await db()
            .select({
                id: folderExportMaterializations.exportConfigurationId,
            })
            .from(folderExportMaterializations)
            .where(eq(folderExportMaterializations.itemId, firstMail))
            .limit(1);
        await deleteMail("u-jan", firstMail);
        await exportNow("u-jan", configuration?.id ?? "");
        expect(
            filesUnder(
                path.join(mockEnv.FILESYSTEM_EXPORT_ROOT, "mine"),
            ).filter((file) => file.startsWith("Contract/")),
        ).toEqual([]);
    });
});
