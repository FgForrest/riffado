/**
 * Server-side search of the pile against a real PostgreSQL: a mail is
 * found by what it says itself (never by what it quotes, its signature or
 * its disclaimer), a recording by its transcript, each library reads only
 * its own items, accents and case are ignored, and a colleague's mail in
 * the Organization library has its secret addresses masked.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    accounts,
    mailMessages,
    recordingFolders,
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

import { markRecordingDeleted } from "@/db/items";
import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, ensureRootFolders } from "@/lib/folders/folders";
import { createSecretAddress, ensureMailbox } from "@/lib/mail/addresses";
import { authenticateMessage } from "@/lib/mail/dkim";
import { ingestMail, precheckMail } from "@/lib/mail/ingest";
import { ensureOrgAccount } from "@/lib/org/account";
import { foldForSearch, searchItems } from "@/lib/search/item-search";
import { insertRecordings } from "@/tests/integration/items";
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
    "Příliš žluťoučký kůň: the pilot budget is approved.",
    "",
    "Best regards,",
    "Jan Novotny",
    "Head of Lighthouse",
    "",
    "On Thu, 8 Oct 2026 at 17:40, Eva Buyer <eva@client.example> wrote:",
    "> The warehouse expects the samples on Monday.",
].join("\n");

describeWithDatabase("searching the pile (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let storageDir = "";
    let orgUserId = "";
    let janMail = "";
    let evaMail = "";
    let token = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function deliver(
        userMailbox: string,
        subject: string,
        body: string,
        from = "Jan Novotny <jan@company.example>",
    ): Promise<string> {
        const raw = await signMessage(
            rawMessage(
                [
                    `From: ${from}`,
                    `To: ${userMailbox}`,
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
        await precheckMail({ recipients: [userMailbox], facts });
        await ingestMail({
            raw,
            recipients: [userMailbox],
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

    const ids = async (
        viewerUserId: string,
        query: string,
        view: "private" | "org" = "private",
    ) =>
        (await searchItems({ viewerUserId, view, query })).hits.map(
            (hit) => hit.id,
        );

    beforeAll(async () => {
        storageDir = mkdtempSync(path.join(tmpdir(), "riffado-search-"));
        mockEnv.LOCAL_STORAGE_PATH = storageDir;
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "item_search",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        orgUserId = (await ensureOrgAccount()) ?? "";
        for (const [id, email, sub] of [
            ["u-jan", "jan@company.example", "sub-jan"],
            ["u-eva", "eva@company.example", "sub-eva"],
        ] as const) {
            await db().insert(users).values({
                id,
                email,
                emailVerified: true,
                lastSsoLoginAt: new Date(),
            });
            await db()
                .insert(accounts)
                .values({ userId: id, accountId: sub, providerId: "oidc" });
            await ensureRootFolders(id);
        }
        const mailbox = await ensureMailbox("u-jan");
        await ensureMailbox("u-eva");
        const secret = await createSecretAddress({
            userId: "u-jan",
            baseAddressId: mailbox?.id ?? "",
            label: null,
        });
        token = secret.localPart;
        janMail = await deliver(
            "jan@klepna.example",
            "Pilot",
            `${BODY}\n\nFile the receipts through ${secret.localPart}@klepna.example please.`,
        );
        evaMail = await deliver(
            "eva@klepna.example",
            "Eva's own",
            "The pilot budget is Eva's secret too.",
            "Eva Buyer <eva@company.example>",
        );
        expect(evaMail).not.toBe(janMail);
        await insertRecordings(db(), {
            id: "rec-jan",
            userId: "u-jan",
            deviceSn: "SN-1",
            plaudFileId: "plaud-rec-jan",
            filename: encryptText("Weekly sync"),
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 1000,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: "u-jan/rec-jan.mp3",
            plaudVersion: "1",
        });
        await db()
            .insert(transcriptions)
            .values({
                recordingId: "rec-jan",
                userId: "u-jan",
                text: encryptText("We talked about the zeppelin roadmap."),
                provider: "openai",
                model: "whisper-1",
                source: "riffado",
            });
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        rmSync(storageDir, { recursive: true, force: true });
    }, 30_000);

    it("folds case and accents", () => {
        expect(foldForSearch("Příliš ŽLUŤOUČKÝ")).toBe("prilis zlutoucky");
    });

    it("finds a mail by what it says itself, accents and case aside", async () => {
        const result = await searchItems({
            viewerUserId: "u-jan",
            view: "private",
            query: "zlutoucky BUDGET",
        });
        expect(result.complete).toBe(true);
        expect(result.hits).toEqual([
            expect.objectContaining({
                id: janMail,
                kind: "mail",
                snippet: expect.stringContaining("žluťoučký kůň"),
            }),
        ]);
    });

    it("never finds a mail by what it quotes or by its signature", async () => {
        expect(await ids("u-jan", "warehouse")).toEqual([]);
        expect(await ids("u-jan", "Lighthouse")).toEqual([]);
        // The title still finds it.
        expect(await ids("u-jan", "pilot")).toEqual([janMail]);
    });

    it("finds a recording by its transcript", async () => {
        expect(await ids("u-jan", "zeppelin")).toEqual(["rec-jan"]);
    });

    it("reads only the library asked for", async () => {
        expect(await ids("u-eva", "pilot")).toEqual([evaMail]);
        expect(await ids("u-eva", "zeppelin")).toEqual([]);
        expect(await ids("u-eva", "pilot", "org")).toEqual([]);
    });

    it("masks a colleague's secret addresses in the Organization library", async () => {
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
            recordingId: janMail,
            folderId: orgRoot?.id ?? "",
        });
        const { hits } = await searchItems({
            viewerUserId: "u-eva",
            view: "org",
            query: "receipts",
        });
        expect(hits.map((hit) => hit.id)).toEqual([janMail]);
        expect(hits[0]?.snippet).toContain("jan.");
        expect(hits[0]?.snippet).not.toContain(token);
        // Nor does a search spell the token out.
        expect(await ids("u-eva", token.slice(0, 7), "org")).toEqual([]);
        expect(await ids("u-jan", token.slice(0, 7))).toEqual([janMail]);
        // Its owner reads their own.
        const own = await searchItems({
            viewerUserId: "u-jan",
            view: "private",
            query: "receipts",
        });
        expect(own.hits[0]?.snippet).toContain(token);
    });

    it("leaves deleted items out", async () => {
        await markRecordingDeleted(db(), {
            id: "rec-jan",
            userId: "u-jan",
            at: new Date(),
        });
        expect(await ids("u-jan", "zeppelin")).toEqual([]);
    });
});
