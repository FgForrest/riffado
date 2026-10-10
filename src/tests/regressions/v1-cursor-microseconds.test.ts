/**
 * `GET /api/v1/recordings` pages through recordings whose `updated_at`
 * carries microseconds (`defaultNow()`) without losing any: the cursor keeps
 * the full precision. A millisecond cursor issued before still pages, and a
 * malformed one is refused with 400. Against a real PostgreSQL.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { sql } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { recordings, users } from "@/db/schema";
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
import { encryptText } from "@/lib/encryption/fields";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";

interface Page {
    data: { id: string; updated_at: string }[];
    next_cursor: string | null;
    has_more: boolean;
}

function cursorOf(updatedAt: string, id: string): string {
    return Buffer.from(JSON.stringify({ updatedAt, id })).toString("base64url");
}

describeWithDatabase("v1 cursor keeps microseconds (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "v1_cursor_microseconds",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values({ id: ALICE, email: "alice@example.test" });
    });

    function recording(id: string, updatedAt?: Date) {
        return {
            id,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText(`Recording ${id}`),
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/${id}.mp3`,
            storageFilename: `${id}.mp3`,
            plaudVersion: "1",
            ...(updatedAt ? { updatedAt } : {}),
        };
    }

    async function request(query: string) {
        return GET(
            new Request(`http://localhost/api/v1/recordings?${query}`),
            undefined,
        );
    }

    async function page(cursor: string | null): Promise<Page> {
        const params = new URLSearchParams({ limit: "3" });
        if (cursor) params.set("cursor", cursor);
        const response = await request(params.toString());
        expect(response.status).toBe(200);
        return (await response.json()) as Page;
    }

    it("pages through rows sharing one microsecond updated_at, each once", async () => {
        const ids = Array.from(
            { length: 10 },
            (_, index) => `rec-${String(index).padStart(2, "0")}`,
        );
        await insertRecordings(
            db(),
            ids.map((id) => recording(id)),
        );
        const [stamp] = await db()
            .select({
                distinct: sql<number>`count(distinct ${recordings.updatedAt})::int`,
            })
            .from(recordings);
        expect(stamp?.distinct).toBe(1);

        const seen: Page["data"] = [];
        let cursor: string | null = null;
        for (let pages = 0; pages < 10; pages++) {
            const result = await page(cursor);
            seen.push(...result.data);
            cursor = result.next_cursor;
            if (!cursor) break;
        }
        expect(seen.map((row) => row.id)).toEqual([...ids].reverse());
        for (const row of seen) {
            expect(row.updated_at).toMatch(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
            );
        }
    });

    it("still pages from a millisecond cursor issued before", async () => {
        const tie = new Date("2026-10-07T12:00:00.123Z");
        await insertRecordings(db(), [
            recording("rec-a", tie),
            recording("rec-b", tie),
            recording("rec-c", tie),
            recording("rec-old", new Date("2026-10-06T12:00:00Z")),
        ]);
        const result = await page(cursorOf(tie.toISOString(), "rec-c"));
        expect(result.data.map((row) => row.id)).toEqual([
            "rec-b",
            "rec-a",
            "rec-old",
        ]);
        expect(result.has_more).toBe(false);
    });

    it("refuses a malformed cursor timestamp with 400", async () => {
        for (const updatedAt of [
            "2026-02-30T12:00:00Z",
            "2026-10-07T12:00:00Z'::date",
            "yesterday",
        ]) {
            const response = await request(
                `cursor=${cursorOf(updatedAt, "rec-a")}`,
            );
            expect(response.status).toBe(400);
        }
    });
});
