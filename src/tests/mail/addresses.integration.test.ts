/**
 * Mail addresses against a real PostgreSQL: who gets a mailbox, how folder
 * addresses are named, and that a name once given out is never given out
 * again, whatever is deleted.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accounts, mailAddresses, recordingFolders, users } from "@/db/schema";
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

import { deleteUser } from "@/db/queries/billing";
import { decryptText } from "@/lib/encryption/fields";
import {
    createFolder,
    deleteFolder,
    ensureRootFolders,
} from "@/lib/folders/folders";
import {
    backfillMailAddresses,
    createSecretAddress,
    ensureMailbox,
    findFolderAddress,
    mailUserByEmail,
    removeAddress,
    resolveLocalPart,
    rotateSecretAddress,
    setFolderAddress,
} from "@/lib/mail/addresses";
import {
    loadFolderAddresses,
    removeFolderAlias,
    setFolderAlias,
} from "@/lib/mail/folder-addresses";
import { loadMailSettings } from "@/lib/mail/views";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("mail addresses (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";

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
            .values({
                userId: id,
                accountId: `sub-${id}`,
                providerId: "oidc",
            });
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
        const found = rows.find((row) => row.parentId === null);
        if (!found) throw new Error(`no root for ${userId}`);
        return found.id;
    }

    async function addressOfFolder(folderId: string): Promise<string | null> {
        return (await findFolderAddress(folderId))?.localPart ?? null;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mail_addresses",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        orgUserId = (await ensureOrgAccount()) ?? "";
        await ssoUser("u-jan", "Jan@company.example");
        await ssoUser("u-jan2", "jan@other.example");
        // A password account claiming somebody else's email.
        await db().insert(users).values({
            id: "u-mallory",
            email: "ceo@company.example",
            emailVerified: true,
        });
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    it("gives a single sign-on user a mailbox from their verified email", async () => {
        expect((await ensureMailbox("u-jan"))?.localPart).toBe("jan");
        // Idempotent.
        expect((await ensureMailbox("u-jan"))?.localPart).toBe("jan");
        expect((await ensureMailbox("u-jan2"))?.localPart).toBe("jan2");
    });

    it("gives a password account no mailbox, and the policy no such user", async () => {
        expect(await ensureMailbox("u-mallory")).toBeNull();
        expect(await mailUserByEmail("ceo@company.example")).toBeNull();
        expect(await mailUserByEmail("JAN@company.example")).toMatchObject({
            userId: "u-jan",
            active: true,
        });
    });

    it("gives the organization account no mailbox", async () => {
        expect(await ensureMailbox(orgUserId)).toBeNull();
    });

    it("names folder addresses after the path's tail", async () => {
        const root = await rootOf("u-jan");
        const meetings = await createFolder({
            userId: "u-jan",
            parentId: root,
            name: "Meetings",
        });
        const weekly = await createFolder({
            userId: "u-jan",
            parentId: meetings.id,
            name: "Weekly",
        });
        const clients = await createFolder({
            userId: "u-jan",
            parentId: root,
            name: "Clients",
        });
        const clientsWeekly = await createFolder({
            userId: "u-jan",
            parentId: clients.id,
            name: "Weekly",
        });
        expect(await addressOfFolder(meetings.id)).toBe("jan+meetings");
        expect(await addressOfFolder(weekly.id)).toBe("jan+weekly");
        expect(await addressOfFolder(clientsWeekly.id)).toBe(
            "jan+clientsweekly",
        );
        // The same alias under another person's prefix is fine.
        const other = await createFolder({
            userId: "u-jan2",
            parentId: await rootOf("u-jan2"),
            name: "Weekly",
        });
        expect(await addressOfFolder(other.id)).toBe("jan2+weekly");
    });

    it("names Organization folders under the nickname", async () => {
        const orgRoot = await rootOf(orgUserId);
        const weekly = await createFolder({
            userId: "u-jan",
            parentId: orgRoot,
            name: "Weekly",
        });
        expect(await addressOfFolder(weekly.id)).toBe("acme-weekly");
        const found = await resolveLocalPart("ACME-Weekly");
        expect(found).toMatchObject({
            kind: "folder",
            folderId: weekly.id,
            namespaceUserId: orgUserId,
            status: "active",
        });
    });

    it("blocks a deleted folder's addresses and its subfolders' for good", async () => {
        const root = await rootOf("u-jan");
        const old = await createFolder({
            userId: "u-jan",
            parentId: root,
            name: "Projects",
        });
        const inner = await createFolder({
            userId: "u-jan",
            parentId: old.id,
            name: "Orion",
        });
        expect(await addressOfFolder(inner.id)).toBe("jan+orion");
        await deleteFolder("u-jan", old.id);
        expect(await resolveLocalPart("jan+projects")).toMatchObject({
            status: "blocked",
            folderId: null,
        });
        expect(await resolveLocalPart("jan+orion")).toMatchObject({
            status: "blocked",
        });
        const again = await createFolder({
            userId: "u-jan",
            parentId: root,
            name: "Orion",
        });
        expect(await addressOfFolder(again.id)).toBe("jan+privateorion");
    });

    it("keeps an edited folder address as secondary, and refuses a used name", async () => {
        const root = await rootOf("u-jan");
        const folder = await createFolder({
            userId: "u-jan",
            parentId: root,
            name: "Board",
        });
        expect(await addressOfFolder(folder.id)).toBe("jan+board");
        await setFolderAddress({
            actorUserId: "u-jan",
            folderId: folder.id,
            alias: "Directors",
        });
        expect(await addressOfFolder(folder.id)).toBe("jan+directors");
        expect(await resolveLocalPart("jan+board")).toMatchObject({
            folderId: folder.id,
            primary: false,
            status: "active",
        });
        await expect(
            setFolderAddress({
                actorUserId: "u-jan",
                folderId: folder.id,
                alias: "orion",
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("extends a personal address with a secret one, revocable for good", async () => {
        const mailbox = await resolveLocalPart("jan");
        if (!mailbox) throw new Error("no mailbox");
        const secret = await createSecretAddress({
            userId: "u-jan",
            baseAddressId: mailbox.id,
            label: "Gmail filter",
        });
        expect(secret.localPart).toMatch(/^jan\.[a-z2-7]{10}$/);
        expect(secret.label).toBe("Gmail filter");
        await removeAddress({ userId: "u-jan", addressId: secret.id });
        expect(await resolveLocalPart(secret.localPart)).toMatchObject({
            status: "blocked",
        });
        await expect(
            removeAddress({ userId: "u-jan", addressId: mailbox.id }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("rotates a secret address: a new token, the label kept, the old one gone", async () => {
        const mailbox = await resolveLocalPart("jan");
        if (!mailbox) throw new Error("no mailbox");
        const secret = await createSecretAddress({
            userId: "u-jan",
            baseAddressId: mailbox.id,
            label: "Newsletter",
        });
        const rotated = await rotateSecretAddress({
            userId: "u-jan",
            addressId: secret.id,
        });
        expect(rotated.id).not.toBe(secret.id);
        expect(rotated.localPart).toMatch(/^jan\.[a-z2-7]{10}$/);
        expect(rotated.localPart).not.toBe(secret.localPart);
        expect(rotated).toMatchObject({
            label: "Newsletter",
            baseAddressId: mailbox.id,
            status: "active",
        });
        expect(await resolveLocalPart(secret.localPart)).toMatchObject({
            status: "blocked",
        });
        await expect(
            rotateSecretAddress({ userId: "u-jan2", addressId: rotated.id }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            rotateSecretAddress({ userId: "u-jan", addressId: secret.id }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("lists the user's live addresses for Settings, blocked ones left out", async () => {
        const view = await loadMailSettings("u-jan");
        expect(view).toMatchObject({
            domain: "klepna.example",
            eligible: true,
            receiving: true,
        });
        const addresses = view.addresses.map((address) => address.address);
        expect(addresses).toContain("jan@klepna.example");
        expect(
            addresses.every((address) => address.endsWith("@klepna.example")),
        ).toBe(true);
        const blocked = await db()
            .select({ localPart: mailAddresses.localPart })
            .from(mailAddresses)
            .where(eq(mailAddresses.status, "blocked"));
        for (const row of blocked) {
            expect(addresses).not.toContain(
                `${decryptText(row.localPart)}@klepna.example`,
            );
        }
        expect(await loadMailSettings("u-mallory")).toMatchObject({
            eligible: false,
            receiving: false,
            addresses: [],
        });
    });

    it("shows a folder's addresses to whoever reaches it, and lets them change them", async () => {
        const personal = await createFolder({
            userId: "u-jan",
            parentId: await rootOf("u-jan"),
            name: "Steering",
        });
        expect(await loadFolderAddresses("u-jan2", personal.id)).toBeNull();
        await expect(
            setFolderAlias({
                userId: "u-jan2",
                folderId: personal.id,
                alias: "mine",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });

        const org = await createFolder({
            userId: "u-jan",
            parentId: await rootOf(orgUserId),
            name: "Suppliers",
        });
        const child = await createFolder({
            userId: "u-jan",
            parentId: org.id,
            name: "Steel",
        });
        // Another member edits the Organization folder's address.
        const edited = await setFolderAlias({
            userId: "u-jan2",
            folderId: org.id,
            alias: "vendors",
        });
        expect(edited.address).toBe("acme-vendors@klepna.example");
        const listed = await loadFolderAddresses("u-jan2", org.id);
        expect(listed?.writable).toBe(true);
        expect(
            listed?.addresses.map((address) => [
                address.address,
                address.primary,
            ]),
        ).toEqual([
            ["acme-vendors@klepna.example", true],
            ["acme-suppliers@klepna.example", false],
        ]);
        const subtree = await loadFolderAddresses("u-jan", org.id, {
            subtree: true,
        });
        expect(
            subtree?.addresses.map((address) => address.folderId).sort(),
        ).toEqual([org.id, org.id, child.id].sort());

        const secondary = listed?.addresses.find((address) => !address.primary);
        // Its creator cannot stop it past the folder's own permission check.
        await expect(
            removeAddress({ userId: "u-jan", addressId: secondary?.id ?? "" }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            removeFolderAlias({
                userId: "u-jan",
                folderId: org.id,
                addressId: edited.id,
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await removeFolderAlias({
            userId: "u-jan",
            folderId: org.id,
            addressId: secondary?.id ?? "",
        });
        expect(
            (await loadFolderAddresses("u-jan", org.id))?.addresses.map(
                (address) => address.address,
            ),
        ).toEqual(["acme-vendors@klepna.example"]);
        expect(await resolveLocalPart("acme-suppliers")).toMatchObject({
            status: "blocked",
        });
    });

    it("refuses a secret address on an Organization address", async () => {
        const weekly = await resolveLocalPart("acme-weekly");
        if (!weekly) throw new Error("no address");
        await expect(
            createSecretAddress({
                userId: "u-jan",
                baseAddressId: weekly.id,
                label: null,
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("blocks a deleted account's addresses and keeps the names taken", async () => {
        await ssoUser("u-gone", "gone@company.example");
        expect((await ensureMailbox("u-gone"))?.localPart).toBe("gone");
        const folder = await createFolder({
            userId: "u-gone",
            parentId: await rootOf("u-gone"),
            name: "Notes",
        });
        expect(await addressOfFolder(folder.id)).toBe("gone+notes");
        expect(await deleteUser("u-gone")).toBe(true);
        const rows = await db()
            .select({
                status: mailAddresses.status,
                namespaceUserId: mailAddresses.namespaceUserId,
                localPart: mailAddresses.localPart,
            })
            .from(mailAddresses);
        const gone = rows.filter((row) =>
            decryptText(row.localPart).startsWith("gone"),
        );
        expect(gone).toHaveLength(2);
        for (const row of gone) {
            expect(row).toMatchObject({
                status: "blocked",
                namespaceUserId: null,
            });
        }
        await ssoUser(
            "u-new",
            "gone@company.example".replace("company", "new"),
        );
        expect((await ensureMailbox("u-new"))?.localPart).toBe("gone2");
    });

    it("backfills what is missing, and nothing twice", async () => {
        await ssoUser("u-late", "late@company.example");
        const first = await backfillMailAddresses();
        expect(first.mailboxes).toBeGreaterThanOrEqual(1);
        const second = await backfillMailAddresses();
        expect(second).toEqual({ mailboxes: 0, folders: 0 });
        expect((await ensureMailbox("u-late"))?.localPart).toBe("late");
    });
});
