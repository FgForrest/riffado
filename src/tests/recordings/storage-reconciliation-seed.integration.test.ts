/**
 * The boot seeder queues one storage scan per user owning a live recording,
 * against a real PostgreSQL.
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

const { dbProxy, dbRef, enqueueJob } = vi.hoisted(() => {
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
    return { dbProxy: proxy, dbRef: ref, enqueueJob: vi.fn() };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/db/queries/async-jobs", () => ({ enqueueJob }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));

import { seedStorageReconciliationJobs } from "@/lib/recordings/storage-reconciliation-job";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("storage reconciliation seeder (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "storage_reconciliation_seed",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    function recording(id: string, userId: string, deletedAt: Date | null) {
        return {
            id,
            userId,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: id,
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${userId}/${id}.mp3`,
            storageFilename: `${id}.mp3`,
            plaudVersion: "1",
            deletedAt,
        };
    }

    it("queues the owners of live recordings, once each", async () => {
        await db()
            .insert(users)
            .values([
                { id: "user-live", email: "live@example.test" },
                { id: "user-mixed", email: "mixed@example.test" },
                { id: "user-deleted", email: "deleted@example.test" },
                { id: "user-empty", email: "empty@example.test" },
            ]);
        const gone = new Date("2026-09-02T10:00:00Z");
        await insertRecordings(db(), [
            recording("rec-1", "user-live", null),
            recording("rec-2", "user-live", null),
            recording("rec-3", "user-mixed", gone),
            recording("rec-4", "user-mixed", null),
            recording("rec-5", "user-deleted", gone),
        ]);
        enqueueJob.mockResolvedValue({ job: { id: "job" }, created: true });

        await expect(seedStorageReconciliationJobs()).resolves.toBe(2);
        expect(
            enqueueJob.mock.calls
                .map(([input]) => (input as { userId: string }).userId)
                .sort(),
        ).toEqual(["user-live", "user-mixed"]);
    });
});
