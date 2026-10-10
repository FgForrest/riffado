/**
 * Inbound mail end to end against a real PostgreSQL and local storage:
 * DKIM-signed fixtures (a test key, a stubbed resolver) through precheck
 * and ingest, into items, participants, segments, folders, pending shares,
 * the delivery log and an encrypted raw file.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import unzipper from "unzipper";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    accounts,
    chatterItems,
    mailContents,
    mailDeliveryLog,
    mailMessages,
    mailParticipants,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
    recordingTasks,
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

import { POST as ingestRoute } from "@/app/api/internal/mail/ingest/route";
import { POST as precheckRoute } from "@/app/api/internal/mail/precheck/route";
import { decryptBuffer } from "@/lib/encryption";
import {
    decryptJsonField,
    decryptText,
    encryptText,
} from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import {
    addRecordingToFolder,
    createFolder,
    ensureRootFolders,
    removeRecordingFromFolder,
} from "@/lib/folders/folders";
import {
    createSecretAddress,
    ensureMailbox,
    findFolderAddress,
    findMailbox,
} from "@/lib/mail/addresses";
import { collectArchivedMail } from "@/lib/mail/archive";
import { loadMailDetail, mailRawFor } from "@/lib/mail/detail";
import { authenticateMessage } from "@/lib/mail/dkim";
import { ingestMail, precheckMail } from "@/lib/mail/ingest";
import { loadMailListRows, loadSharedMailRows } from "@/lib/mail/list";
import { deleteMail, shareMail } from "@/lib/mail/manage";
import { loadDeliveryLog } from "@/lib/mail/views";
import { ensureOrgAccount } from "@/lib/org/account";
import { LocalStorage } from "@/lib/storage/local-storage";
import type { StorageProvider } from "@/lib/storage/types";
import {
    rawMessage,
    signMessage,
    testResolver,
    testSigner,
} from "@/tests/mail/dkim-fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const company = testSigner("company.example");
const google = testSigner("google.com");
const resolver = testResolver([company, google]);

describeWithDatabase("inbound mail (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let storageDir = "";
    let orgUserId = "";
    let weeklyFolderId = "";
    let orgWeeklyFolderId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function ssoUser(id: string, email: string) {
        await db().insert(users).values({
            id,
            email,
            emailVerified: true,
            lastSsoLoginAt: new Date(),
        });
        await db()
            .insert(accounts)
            .values({ userId: id, accountId: `sub-${id}`, providerId: "oidc" });
        await ensureRootFolders(id);
    }

    async function rootOf(userId: string): Promise<string> {
        const rows = await db()
            .select({
                id: recordingFolders.id,
                parentId: recordingFolders.parentId,
            })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, userId));
        const root = rows.find((row) => row.parentId === null);
        if (!root) throw new Error("no root");
        return root.id;
    }

    function headers(from: string, to: string, extra: string[] = []) {
        return [
            `From: ${from}`,
            `To: ${to}`,
            "Subject: Conditions for November",
            "Date: Fri, 09 Oct 2026 14:02:00 +0200",
            `Message-ID: <${Math.random().toString(36).slice(2)}@company.example>`,
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            ...extra,
        ];
    }

    const BODY = [
        "Eva's conditions are below, we answer by Friday.",
        "",
        "Best regards,",
        "Jan Novotny",
        "",
        "On Thu, 8 Oct 2026 at 17:40, Eva Buyer <eva@client.example> wrote:",
        "> We can accept the price if delivery is in November.",
    ].join("\n");

    async function deliver(raw: Buffer, recipients: string[]) {
        const now = new Date();
        const facts = await authenticateMessage(raw, { resolver, now });
        const precheck = await precheckMail({ recipients, facts });
        if (precheck.accepted.length === 0) return { precheck, ingest: null };
        const ingest = await ingestMail({
            raw,
            recipients,
            spf: "pass",
            receivedAt: now,
            resolver,
        });
        return { precheck, ingest };
    }

    beforeAll(async () => {
        storageDir = mkdtempSync(join(tmpdir(), "riffado-mail-"));
        mockEnv.LOCAL_STORAGE_PATH = storageDir;
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mail_ingest",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        orgUserId = (await ensureOrgAccount()) ?? "";
        await ssoUser("u-jan", "jan@company.example");
        await ssoUser("u-eva", "eva@company.example");
        await ensureMailbox("u-jan");
        await ensureMailbox("u-eva");
        const weekly = await createFolder({
            userId: "u-jan",
            parentId: await rootOf("u-jan"),
            name: "Weekly",
        });
        weeklyFolderId = weekly.id;
        const orgWeekly = await createFolder({
            userId: "u-jan",
            parentId: await rootOf(orgUserId),
            name: "Weekly",
        });
        orgWeeklyFolderId = orgWeekly.id;
        expect((await findFolderAddress(weekly.id))?.localPart).toBe(
            "jan+weekly",
        );
        expect((await findFolderAddress(orgWeekly.id))?.localPart).toBe(
            "acme-weekly",
        );
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
        rmSync(storageDir, { recursive: true, force: true });
    }, 30_000);

    it("files the owner's signed mail into their folder, encrypted throughout", async () => {
        const raw = await signMessage(
            rawMessage(
                headers(
                    "Jan Novotny <jan@company.example>",
                    "jan+weekly@klepna.example",
                ),
                BODY,
            ),
            company,
        );
        const { precheck, ingest } = await deliver(raw, [
            "jan+weekly@klepna.example",
        ]);
        expect(precheck.accepted).toEqual(["jan+weekly@klepna.example"]);
        expect(ingest?.outcomes).toEqual([
            { recipient: "jan+weekly@klepna.example", outcome: "accepted" },
        ]);

        const [message] = await db()
            .select()
            .from(mailMessages)
            .where(eq(mailMessages.userId, "u-jan"));
        if (!message) throw new Error("no message");
        expect(message.senderVerified).toBe(true);
        expect(message.autoGenerated).toBe(false);

        const [item] = await db()
            .select()
            .from(chatterItems)
            .where(eq(chatterItems.id, message.id));
        expect(item?.kind).toBe("mail");
        expect(item?.title).not.toContain("Conditions");
        expect(decryptText(item?.title ?? "")).toBe("Conditions for November");

        const assignments = await db()
            .select({ folderId: recordingFolderAssignments.folderId })
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, message.id));
        expect(assignments).toEqual([{ folderId: weeklyFolderId }]);

        const participants = await db()
            .select()
            .from(mailParticipants)
            .where(eq(mailParticipants.itemId, message.id));
        expect(participants.map((p) => p.ref).sort()).toEqual([
            "p1",
            "p2",
            "p3",
        ]);
        for (const participant of participants) {
            expect(participant.address ?? "").not.toContain("@");
        }
        const from = participants.find((p) => p.ref === "p1");
        expect(decryptText(from?.address ?? "")).toBe("jan@company.example");
        expect(from?.authenticated).toBe(true);

        const [content] = await db()
            .select()
            .from(mailContents)
            .where(eq(mailContents.itemId, message.id));
        const segments = decryptJsonField<{ role: string; text: string }[]>(
            content?.segments,
        );
        expect((segments ?? []).map((segment) => segment.role)).toEqual([
            "body",
            "signature",
            "quoted",
        ]);
        expect(JSON.stringify(content?.segments)).not.toContain("Friday");

        const stored = readFileSync(
            join(storageDir, message.rawStoragePath ?? ""),
        );
        expect(stored.includes(Buffer.from("Friday"))).toBe(false);
        expect(decryptBuffer(stored).equals(raw)).toBe(true);
    });

    it("stores a retry once, and a second recipient files the same item", async () => {
        const raw = await signMessage(
            rawMessage(
                headers(
                    "jan@company.example",
                    "jan@klepna.example, jan+weekly@klepna.example",
                ),
                "Once only.",
            ),
            company,
        );
        await deliver(raw, ["jan@klepna.example"]);
        const again = await deliver(raw, ["jan+weekly@klepna.example"]);
        expect(again.ingest?.outcomes[0]?.outcome).toBe("duplicate");
        const rows = await db()
            .select({ id: mailMessages.id })
            .from(mailMessages)
            .where(eq(mailMessages.sizeBytes, raw.length));
        expect(rows).toHaveLength(1);
        const assignments = await db()
            .select({ folderId: recordingFolderAssignments.folderId })
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, rows[0]?.id ?? ""));
        expect(assignments).toEqual([{ folderId: weeklyFolderId }]);
    });

    it("refuses mail from someone else to a personal address, and logs it for the owner", async () => {
        const raw = await signMessage(
            rawMessage(
                headers("eva@company.example", "jan@klepna.example"),
                "Hi Jan",
            ),
            company,
        );
        const { precheck, ingest } = await deliver(raw, ["jan@klepna.example"]);
        expect(precheck.accepted).toEqual([]);
        expect(ingest).toBeNull();
        const log = await db()
            .select({
                outcome: mailDeliveryLog.outcome,
                reason: mailDeliveryLog.reason,
            })
            .from(mailDeliveryLog)
            .where(
                and(
                    eq(mailDeliveryLog.userId, "u-jan"),
                    eq(mailDeliveryLog.outcome, "refused"),
                ),
            );
        expect(log).toEqual([
            { outcome: "refused", reason: "sender_mismatch" },
        ]);
    });

    it("refuses an unsigned mail, even with the owner's From", async () => {
        const raw = Buffer.from(
            rawMessage(
                headers("jan@company.example", "jan@klepna.example"),
                "Forged",
            ),
        );
        const { precheck } = await deliver(raw, ["jan@klepna.example"]);
        expect(precheck.accepted).toEqual([]);
        // Even if a broken receiver sent it anyway, ingest verifies itself.
        const forced = await ingestMail({
            raw,
            recipients: ["jan@klepna.example"],
            spf: "pass",
            receivedAt: new Date(),
            resolver,
        });
        expect(forced.outcomes[0]?.outcome).toBe("refused");
    });

    it("keeps a mail to an Organization address in the sender's pile, waiting to be shared", async () => {
        const raw = await signMessage(
            rawMessage(
                headers("eva@company.example", "acme-weekly@klepna.example"),
                "For the weekly.",
            ),
            company,
        );
        const { ingest } = await deliver(raw, ["acme-weekly@klepna.example"]);
        expect(ingest?.outcomes[0]?.outcome).toBe("accepted");
        const [message] = await db()
            .select({ id: mailMessages.id, userId: mailMessages.userId })
            .from(mailMessages)
            .where(eq(mailMessages.userId, "u-eva"));
        expect(message?.userId).toBe("u-eva");
        const pending = await db()
            .select({ folderId: mailPendingShares.folderId })
            .from(mailPendingShares)
            .where(eq(mailPendingShares.itemId, message?.id ?? ""));
        expect(pending).toEqual([{ folderId: orgWeeklyFolderId }]);
        const assigned = await db()
            .select()
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, message?.id ?? ""));
        expect(assigned).toEqual([]);
    });

    it("lists mail in the owner's pile and shows it, decrypted", async () => {
        const rows = await loadMailListRows("u-jan");
        // The first message: the only one sent with a display name.
        const row = rows.find((r) => r.mail?.from === "Jan Novotny");
        expect(row).toMatchObject({
            kind: "mail",
            mail: {
                from: "Jan Novotny",
                senderVerified: true,
                waitingToShare: false,
            },
        });
        const detail = await loadMailDetail("u-jan", row?.id ?? "");
        expect(detail?.subject).toBe("Conditions for November");
        expect(detail?.segments.map((segment) => segment.role)).toEqual([
            "body",
            "signature",
            "quoted",
        ]);
        expect(detail?.folderIds).toEqual([weeklyFolderId]);
        // Nobody else's.
        expect(await loadMailDetail("u-eva", row?.id ?? "")).toBeNull();
    });

    it("shares a mail into the Organization folder it was sent to, once asked", async () => {
        const [row] = (await loadMailListRows("u-eva")).filter(
            (r) => r.mail?.waitingToShare,
        );
        if (!row) throw new Error("no waiting mail");
        await expect(
            shareMail({
                ownerUserId: "u-jan",
                itemId: row.id,
                folderId: orgWeeklyFolderId,
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await shareMail({
            ownerUserId: "u-eva",
            itemId: row.id,
            folderId: orgWeeklyFolderId,
        });
        const assigned = await db()
            .select({ folderId: recordingFolderAssignments.folderId })
            .from(recordingFolderAssignments)
            .where(eq(recordingFolderAssignments.itemId, row.id));
        expect(assigned).toEqual([{ folderId: orgWeeklyFolderId }]);
        const detail = await loadMailDetail("u-eva", row.id);
        expect(detail?.pendingShares).toEqual([]);
    });

    it("files a mail like a recording: personal folders freely, the Organization through the gate", async () => {
        const raw = await signMessage(
            rawMessage(
                headers("jan@company.example", "jan@klepna.example"),
                "A note to file later.",
            ),
            company,
        );
        await deliver(raw, ["jan@klepna.example"]);
        const [message] = await db()
            .select({ id: mailMessages.id })
            .from(mailMessages)
            .where(eq(mailMessages.sizeBytes, raw.length));
        const itemId = message?.id ?? "";
        const assigned = async () =>
            (
                await db()
                    .select({ folderId: recordingFolderAssignments.folderId })
                    .from(recordingFolderAssignments)
                    .where(eq(recordingFolderAssignments.itemId, itemId))
            )
                .map((row) => row.folderId)
                .sort();

        await addRecordingToFolder({
            userId: "u-jan",
            recordingId: itemId,
            folderId: weeklyFolderId,
        });
        expect(await assigned()).toEqual([weeklyFolderId]);
        // Only its owner shares it.
        await expect(
            addRecordingToFolder({
                userId: "u-eva",
                recordingId: itemId,
                folderId: orgWeeklyFolderId,
            }),
        ).rejects.toMatchObject({ statusCode: 404 });

        const [task] = await db()
            .insert(recordingTasks)
            .values({
                itemId,
                userId: "u-jan",
                status: "proposed",
                source: "riffado",
                text: encryptText("Answer by Friday"),
            })
            .returning({ id: recordingTasks.id });
        await expect(
            addRecordingToFolder({
                userId: "u-jan",
                recordingId: itemId,
                folderId: orgWeeklyFolderId,
            }),
        ).rejects.toMatchObject({
            statusCode: 409,
            details: {
                problems: [{ kind: "tasks_unreviewed", proposals: 1 }],
            },
        });
        expect(await assigned()).toEqual([weeklyFolderId]);

        await db()
            .update(recordingTasks)
            .set({ status: "open" })
            .where(eq(recordingTasks.id, task?.id ?? ""));
        await addRecordingToFolder({
            userId: "u-jan",
            recordingId: itemId,
            folderId: orgWeeklyFolderId,
        });
        expect(await assigned()).toEqual(
            [weeklyFolderId, orgWeeklyFolderId].sort(),
        );

        await expect(
            removeRecordingFromFolder({
                userId: "u-jan",
                recordingId: itemId,
                folderId: orgWeeklyFolderId,
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await removeRecordingFromFolder({
            userId: "u-jan",
            recordingId: itemId,
            folderId: orgWeeklyFolderId,
            withdraw: true,
        });
        expect(await assigned()).toEqual([weeklyFolderId]);
    });

    it("shows the owner their delivery log, decrypted, and nobody else's", async () => {
        const entries = await loadDeliveryLog("u-jan");
        expect(entries.length).toBeGreaterThan(0);
        const refused = entries.find(
            (entry) =>
                entry.reason === "sender_mismatch" &&
                entry.senderDomain === "company.example",
        );
        expect(refused).toMatchObject({
            address: "jan@klepna.example",
            senderDomain: "company.example",
            outcome: "refused",
            itemId: null,
        });
        const accepted = entries.find((entry) => entry.outcome === "accepted");
        expect(accepted?.itemId).toEqual(expect.any(String));
        const times = entries.map((entry) => Date.parse(entry.at));
        expect([...times].sort((a, b) => b - a)).toEqual(times);
        const evas = await loadDeliveryLog("u-eva");
        expect(
            evas.every((entry) => entry.address !== "jan@klepna.example"),
        ).toBe(true);
    });

    it("backs up mail: the owner's own, and the Organization's shared ones", async () => {
        const mine = await collectArchivedMail({
            kind: "personal",
            userId: "u-jan",
        });
        expect(mine.length).toBeGreaterThanOrEqual(2);
        expect(mine.every((mail) => mail.ownerUserId === "u-jan")).toBe(true);
        const shared = await collectArchivedMail({
            kind: "organization",
            orgUserId,
        });
        expect(shared.map((mail) => mail.ownerUserId)).toEqual(["u-eva"]);

        const source = new LocalStorage(storageDir);
        let uploaded = Buffer.alloc(0);
        const destination: StorageProvider = {
            ...source,
            uploadFile: async (key) => key,
            uploadStream: async (key: string, stream: Readable) => {
                const chunks: Buffer[] = [];
                for await (const chunk of stream)
                    chunks.push(Buffer.from(chunk));
                uploaded = Buffer.concat(chunks);
                return key;
            },
            downloadFile: (key) => source.downloadFile(key),
            downloadStream: (key) => source.downloadStream(key),
            exists: (key) => source.exists(key),
            getSignedUrl: (key, expires) => source.getSignedUrl(key, expires),
            deleteFile: (key) => source.deleteFile(key),
            testConnection: () => source.testConnection(),
        };
        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: "u-jan" },
            sourceStorage: source,
            destinationStorage: destination,
            storageKey: "exports/u-jan.zip",
        });
        const directory = await unzipper.Open.buffer(uploaded);
        const names = directory.files.map((entry) => entry.path);
        const emls = names.filter((name) => name.endsWith("/message.eml"));
        expect(emls.length).toBe(mine.length);
        const manifest = JSON.parse(
            (
                await directory.files
                    .find((entry) => entry.path === "manifest.json")
                    ?.buffer()
            )?.toString() ?? "{}",
        );
        expect(manifest.mail).toHaveLength(mine.length);
        for (const entry of manifest.mail as { raw: unknown }[]) {
            expect(entry.raw).toEqual({ included: true });
        }
        const first = directory.files.find((entry) => entry.path === emls[0]);
        const eml = (await first?.buffer())?.toString() ?? "";
        expect(eml).toContain("From:");
        expect(eml).not.toContain("RFE1");
    });

    it("deletes a mail with everything on it, raw message included", async () => {
        const raw = await signMessage(
            rawMessage(
                headers("jan@company.example", "jan@klepna.example"),
                "To be deleted.",
            ),
            company,
        );
        await deliver(raw, ["jan@klepna.example"]);
        const [message] = await db()
            .select({ id: mailMessages.id, path: mailMessages.rawStoragePath })
            .from(mailMessages)
            .where(eq(mailMessages.sizeBytes, raw.length));
        if (!message?.path) throw new Error("not stored");
        await deleteMail("u-jan", message.id);
        expect(
            await db()
                .select()
                .from(chatterItems)
                .where(eq(chatterItems.id, message.id)),
        ).toEqual([]);
        expect(
            await db()
                .select()
                .from(mailParticipants)
                .where(eq(mailParticipants.itemId, message.id)),
        ).toEqual([]);
        expect(() =>
            readFileSync(join(storageDir, message.path ?? "")),
        ).toThrow();
        await expect(deleteMail("u-eva", message.id)).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    it("refuses an Organization address in BCC only", async () => {
        const raw = await signMessage(
            rawMessage(
                headers("eva@company.example", "client@client.example"),
                "BCC",
            ),
            company,
        );
        const { precheck } = await deliver(raw, ["acme-weekly@klepna.example"]);
        expect(precheck.accepted).toEqual([]);
        const log = await db()
            .select({ reason: mailDeliveryLog.reason })
            .from(mailDeliveryLog)
            .where(
                and(
                    eq(mailDeliveryLog.userId, "u-eva"),
                    eq(mailDeliveryLog.outcome, "refused"),
                ),
            );
        expect(log.map((row) => row.reason)).toContain("not_addressed");
    });

    it("ignores recipients of other domains and unknown addresses alike", async () => {
        const raw = await signMessage(
            rawMessage(
                headers("jan@company.example", "nobody@klepna.example"),
                "?",
            ),
            company,
        );
        const { precheck } = await deliver(raw, [
            "nobody@klepna.example",
            "jan@elsewhere.example",
        ]);
        expect(precheck.accepted).toEqual([]);
    });

    it("leaves no raw file behind for refused mail", async () => {
        const files = readdirSync(join(storageDir, "mail"), {
            recursive: true,
        });
        const stored = await db()
            .select({ path: mailMessages.rawStoragePath })
            .from(mailMessages);
        expect(
            files
                .filter((name) => String(name).endsWith(".eml.enc"))
                .map((name) => `mail/${String(name)}`)
                .sort(),
        ).toEqual(stored.map((row) => row.path).sort());
    });

    it("lets colleagues read a shared mail, its secret addresses masked, but not its original", async () => {
        const mailbox = await findMailbox("u-jan");
        if (!mailbox) throw new Error("no mailbox");
        const secret = await createSecretAddress({
            userId: "u-jan",
            baseAddressId: mailbox.id,
            label: null,
        });
        const secretAddress = `${secret.localPart}@klepna.example`;
        const raw = await signMessage(
            rawMessage(
                [
                    "From: Jan Novotny <jan@company.example>",
                    "To: jan@klepna.example",
                    `Cc: "Archive ${secretAddress}" <${secretAddress}>`,
                    `Subject: Filed under ${secretAddress}`,
                    "Date: Fri, 09 Oct 2026 14:02:00 +0200",
                    "Message-ID: <shared-1@company.example>",
                    "MIME-Version: 1.0",
                    "Content-Type: text/plain; charset=utf-8",
                ],
                `For the record. Copies go to ${secretAddress} too.`,
            ),
            company,
        );
        await deliver(raw, ["jan@klepna.example"]);
        const [message] = await db()
            .select({ id: mailMessages.id })
            .from(mailMessages)
            .where(eq(mailMessages.sizeBytes, raw.length));
        const itemId = message?.id ?? "";
        expect(await loadMailDetail("u-eva", itemId)).toBeNull();
        expect(await mailRawFor("u-eva", itemId)).toBeNull();

        await addRecordingToFolder({
            userId: "u-jan",
            recordingId: itemId,
            folderId: weeklyFolderId,
        });
        await addRecordingToFolder({
            userId: "u-jan",
            recordingId: itemId,
            folderId: orgWeeklyFolderId,
        });

        const seen = await loadMailDetail("u-eva", itemId);
        expect(seen).toMatchObject({ isOwn: false, hasRaw: false });
        expect(seen?.ownerName).toEqual(expect.any(String));
        expect(seen?.folderIds).toEqual([orgWeeklyFolderId]);
        expect(seen?.pendingShares).toEqual([]);
        const shown = JSON.stringify(seen);
        expect(shown).not.toContain(secret.localPart);
        expect(shown).toContain("jan.•••@klepna.example");
        expect((await mailRawFor("u-eva", itemId))?.access.role).toBe("member");

        const own = await loadMailDetail("u-jan", itemId);
        expect(own).toMatchObject({ isOwn: true, hasRaw: true });
        expect(JSON.stringify(own)).toContain(secretAddress);
        expect(own?.folderIds.sort()).toEqual(
            [weeklyFolderId, orgWeeklyFolderId].sort(),
        );

        const library = await loadSharedMailRows("u-eva", orgUserId);
        const listed = library.find((row) => row.id === itemId);
        expect(listed).toMatchObject({
            kind: "mail",
            view: "org",
            isOwn: false,
            filename: "Filed under jan.•••@klepna.example",
        });
        expect(
            (await loadSharedMailRows("u-jan", orgUserId)).find(
                (row) => row.id === itemId,
            )?.isOwn,
        ).toBe(true);
    });

    it("takes Gmail's forwarding confirmation on a secret address, from Google", async () => {
        const mailbox = await findMailbox("u-jan");
        if (!mailbox) throw new Error("no mailbox");
        const secret = await createSecretAddress({
            userId: "u-jan",
            baseAddressId: mailbox.id,
            label: "Gmail filter",
        });
        const to = `${secret.localPart}@klepna.example`;
        const raw = await signMessage(
            rawMessage(
                [
                    "From: Gmail Team <forwarding-noreply@google.com>",
                    `To: ${to}`,
                    "Subject: (#123456789) Gmail Forwarding Confirmation",
                    "Date: Fri, 09 Oct 2026 14:02:00 +0000",
                    "Message-ID: <confirm-1@google.com>",
                    "MIME-Version: 1.0",
                    "Content-Type: text/plain; charset=utf-8",
                ],
                "Confirmation code: 123456789",
            ),
            google,
        );
        // The same mail to the plain mailbox is someone else's.
        expect((await deliver(raw, ["jan@klepna.example"])).ingest).toBeNull();
        const { ingest } = await deliver(raw, [to]);
        expect(ingest?.outcomes[0]?.outcome).toBe("accepted");
        const [row] = (await loadMailListRows("u-jan")).filter((r) =>
            r.filename.includes("Gmail Forwarding Confirmation"),
        );
        expect(row?.mail?.senderVerified).toBe(true);
        const detail = await loadMailDetail("u-jan", row?.id ?? "");
        expect(
            detail?.segments.some((segment) =>
                segment.text.includes("123456789"),
            ),
        ).toBe(true);
    });

    describe("the receiver's endpoints", () => {
        const secret = `Bearer ${"i".repeat(40)}`;

        function ingestRequest(
            raw: Buffer,
            headers: Record<string, string> = {},
        ): Request {
            return new Request("http://app/api/internal/mail/ingest", {
                method: "POST",
                body: new Uint8Array(raw),
                headers: {
                    authorization: secret,
                    "content-length": String(raw.length),
                    "x-mail-sha256": createHash("sha256")
                        .update(raw)
                        .digest("hex"),
                    "x-mail-recipients": Buffer.from(
                        JSON.stringify(["jan@klepna.example"]),
                    ).toString("base64"),
                    ...headers,
                },
            });
        }

        it("refuse a wrong secret, then rate-limit it", async () => {
            const statuses = new Set<number>();
            for (let i = 0; i < 22; i++) {
                const response = await precheckRoute(
                    new Request("http://app/api/internal/mail/precheck", {
                        method: "POST",
                        headers: { authorization: "Bearer wrong" },
                        body: "{}",
                    }),
                );
                statuses.add(response.status);
            }
            expect([...statuses].sort()).toEqual([401, 429]);
        });

        it("answers a precheck with the recipients that would pass", async () => {
            const response = await precheckRoute(
                new Request("http://app/api/internal/mail/precheck", {
                    method: "POST",
                    headers: { authorization: secret },
                    body: JSON.stringify({
                        recipients: ["jan@klepna.example"],
                        facts: {
                            fromHeaders: 1,
                            fromAddresses: ["jan@company.example"],
                            dkim: [
                                {
                                    domain: "company.example",
                                    result: "pass",
                                    signedRecipients: [],
                                    signedAt: new Date().toISOString(),
                                },
                            ],
                        },
                    }),
                }),
            );
            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toEqual({
                accepted: ["jan@klepna.example"],
            });
        });

        it("refuse a body whose length or hash does not match", async () => {
            const raw = Buffer.from(
                rawMessage(
                    headers("jan@company.example", "jan@klepna.example"),
                    "x",
                ),
            );
            const wrongHash = await ingestRoute(
                ingestRequest(raw, { "x-mail-sha256": "0".repeat(64) }),
            );
            expect(wrongHash.status).toBe(422);
            const missing = await ingestRoute(
                ingestRequest(raw, { "x-mail-recipients": "" }),
            );
            expect(missing.status).toBe(400);
        });

        it("refuse a message over the size limit before reading it", async () => {
            mockEnv.MAIL_MAX_MESSAGE_MB = 1;
            try {
                const raw = Buffer.alloc(1024 * 1024 + 1, 0x61);
                const response = await ingestRoute(ingestRequest(raw));
                expect(response.status).toBe(413);
            } finally {
                mockEnv.MAIL_MAX_MESSAGE_MB = 36;
            }
        });

        it("ingest an unverifiable message as refused, with 200", async () => {
            // No resolver here: the key lookup fails, so DKIM does not pass.
            const raw = await signMessage(
                rawMessage(
                    headers("jan@company.example", "jan@klepna.example"),
                    "Via the route",
                ),
                company,
            );
            const response = await ingestRoute(ingestRequest(raw));
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
                outcomes: { outcome: string }[];
            };
            expect(body.outcomes[0]?.outcome).toBe("refused");
        });

        it("are not there while mail is off", async () => {
            mockEnv.MAIL_DOMAIN = "";
            try {
                const response = await precheckRoute(
                    new Request("http://app/api/internal/mail/precheck", {
                        method: "POST",
                        headers: { authorization: secret },
                        body: "{}",
                    }),
                );
                expect(response.status).toBe(404);
            } finally {
                mockEnv.MAIL_DOMAIN = "klepna.example";
            }
        });
    });
});
