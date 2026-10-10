/**
 * `GET /api/v1/recordings` pages through a user's live recordings by
 * `(updated_at, id)` against a real PostgreSQL: every recording once, in
 * order, also across rows sharing one `updated_at`.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { users } from "@/db/schema";
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
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/auth-request", () => ({
    authenticateRequest: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-alice" }, via: "session" }),
}));
vi.mock("@/lib/v1/rate-limit", () => ({
    enforceV1IpRateLimit: vi.fn().mockResolvedValue(null),
    enforceV1AuthenticatedRateLimit: vi.fn().mockResolvedValue(null),
}));

import { GET } from "@/app/api/v1/recordings/route";
import { setItemTitle } from "@/db/items";
import { encryptText } from "@/lib/encryption/fields";
import { storeGeneratedTitle } from "@/lib/recordings/generated-title";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

describeWithDatabase("v1 recordings pagination (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "v1_pagination",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    function recording(
        id: string,
        userId: string,
        updatedAt: Date,
        deletedAt: Date | null = null,
    ) {
        return {
            id,
            userId,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText(`Recording ${id}`),
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${userId}/${id}.mp3`,
            storageFilename: `${id}.mp3`,
            plaudVersion: "1",
            updatedAt,
            deletedAt,
        };
    }

    async function page(cursor: string | null) {
        const url = new URL("http://localhost/api/v1/recordings?limit=2");
        if (cursor) url.searchParams.set("cursor", cursor);
        const response = await GET(new Request(url), undefined);
        expect(response.status).toBe(200);
        return (await response.json()) as {
            data: { id: string }[];
            next_cursor: string | null;
            has_more: boolean;
        };
    }

    it("returns every live recording once, newest change first, ties by id", async () => {
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        const tie = new Date("2026-10-07T12:00:00.123Z");
        const older = new Date("2026-10-06T12:00:00.000Z");
        await insertRecordings(db(), [
            recording("rec-a", ALICE, tie),
            recording("rec-b", ALICE, tie),
            recording("rec-c", ALICE, tie),
            recording("rec-d", ALICE, tie),
            recording("rec-e", ALICE, tie),
            recording("rec-old", ALICE, older),
            recording("rec-newest", ALICE, new Date("2026-10-08T00:00Z")),
            recording("rec-deleted", ALICE, tie, new Date()),
            recording("rec-bob", BOB, tie),
        ]);

        const seen: string[] = [];
        let cursor: string | null = null;
        for (let pages = 0; pages < 10; pages++) {
            const result = await page(cursor);
            seen.push(...result.data.map((row) => row.id));
            expect(result.has_more).toBe(result.next_cursor !== null);
            cursor = result.next_cursor;
            if (!cursor) break;
        }
        expect(seen).toEqual([
            "rec-newest",
            "rec-e",
            "rec-d",
            "rec-c",
            "rec-b",
            "rec-a",
            "rec-old",
        ]);
    });

    it("lists a recording whose title changed as changed, newest first", async () => {
        // The title is the item's, but the v1 list pages by the
        // recording's `updated_at`: a rename (`PATCH`) and a generated
        // title both have to move it, or a client never sees them.
        await setItemTitle(db(), {
            id: "rec-old",
            userId: ALICE,
            title: encryptText("Renamed"),
            editedAt: new Date(),
        });
        expect((await page(null)).data[0]?.id).toBe("rec-old");

        expect(await storeGeneratedTitle(ALICE, "rec-a", "Generated")).toBe(
            true,
        );
        const first = await page(null);
        expect(first.data.map((row) => row.id)).toEqual(["rec-a", "rec-old"]);
    });
});
