/**
 * A generated title never replaces one a person set, against a real
 * PostgreSQL: not a rename made before, nor one committing while the title
 * is being stored.
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
import { chatterItems, users } from "@/db/schema";
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
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

import { decryptText, encryptText } from "@/lib/encryption/fields";
import {
    storeGeneratedTitle,
    titleStillGenerated,
} from "@/lib/recordings/generated-title";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const REC = "rec-1";

describeWithDatabase("storing a generated title (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "generated_title",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db().insert(users).values({ id: ALICE, email: "a@x.test" });
        await insertRecordings(db(), {
            id: REC,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("2026-09-01 10:00"),
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/rec.mp3`,
            plaudVersion: "1",
        });
    });

    async function title() {
        const [row] = await db()
            .select({ filename: chatterItems.title })
            .from(chatterItems)
            .where(eq(chatterItems.id, REC));
        return decryptText(row?.filename ?? "");
    }

    /** What renaming does (`PATCH /api/recordings/[id]`). */
    const renamed = {
        title: encryptText("Budget review"),
        titleEditedAt: new Date(),
    };

    it("stores it while no person has set a title", async () => {
        expect(await storeGeneratedTitle(ALICE, REC, "Weekly sync")).toBe(true);
        expect(await title()).toBe("Weekly sync");
        expect(await titleStillGenerated(ALICE, REC)).toBe(true);
    });

    it("keeps a title a person set", async () => {
        await db()
            .update(chatterItems)
            .set(renamed)
            .where(eq(chatterItems.id, REC));

        expect(await storeGeneratedTitle(ALICE, REC, "Weekly sync")).toBe(
            false,
        );
        expect(await title()).toBe("Budget review");
        expect(await titleStillGenerated(ALICE, REC)).toBe(false);
    });

    it("keeps a rename that commits while the title is being stored", async () => {
        let commit = () => {};
        const committed = new Promise<void>((resolve) => {
            commit = resolve;
        });
        let started = () => {};
        const renaming = new Promise<void>((resolve) => {
            started = resolve;
        });
        const rename = db().transaction(async (tx) => {
            await tx
                .update(chatterItems)
                .set(renamed)
                .where(eq(chatterItems.id, REC));
            started();
            await committed;
        });
        await renaming;

        const stored = storeGeneratedTitle(ALICE, REC, "Weekly sync");
        // Long enough for the update to be waiting on the rename's lock.
        await new Promise((resolve) => setTimeout(resolve, 200));
        commit();
        await rename;
        expect(await stored).toBe(false);
        expect(await title()).toBe("Budget review");
    });

    it("stores nothing on somebody else's recording", async () => {
        expect(
            await storeGeneratedTitle("user-mallory", REC, "Weekly sync"),
        ).toBe(false);
        expect(await titleStillGenerated("user-mallory", REC)).toBe(false);
        expect(await title()).toBe("2026-09-01 10:00");
    });
});
