/**
 * Organization invalidations travel through PostgreSQL, not process memory.
 *
 * Several app processes serve the same instance, so a folder renamed through
 * one must reach a browser connected to another. That only holds if the
 * event goes out as `NOTIFY` and comes back in over `LISTEN`, which is what
 * this checks against a real server.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { refs } = vi.hoisted(() => ({
    refs: {
        db: null as Record<PropertyKey, unknown> | null,
        sql: null as Record<PropertyKey, unknown> | null,
    },
}));

function forward(key: "db" | "sql") {
    return new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = refs[key];
                if (!current) throw new Error("test database missing");
                const value = current[property];
                return typeof value === "function"
                    ? value.bind(current)
                    : value;
            },
        },
    );
}

vi.mock("@/db", () => ({ db: forward("db"), sqlClient: forward("sql") }));

import {
    notifyOrgChange,
    type OrgEvent,
    subscribeOrgEvents,
} from "@/lib/org/events";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

function nextEvent(): Promise<OrgEvent> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error("no event within 5s")),
            5_000,
        );
        const unsubscribe = subscribeOrgEvents((event) => {
            clearTimeout(timer);
            unsubscribe();
            resolve(event);
        });
    });
}

describeWithDatabase("Organization events (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "org_events",
        );
        refs.db = database.db as unknown as Record<PropertyKey, unknown>;
        refs.sql = database.sql as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        refs.db = null;
        refs.sql = null;
        await database?.dispose();
    }, 30_000);

    it("delivers a notification to every subscriber in the process", async () => {
        const first = nextEvent();
        const second = nextEvent();
        // LISTEN is established on first subscribe; give it a moment.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await notifyOrgChange({ type: "recording", recordingId: "rec-1" });
        await expect(first).resolves.toEqual({
            type: "recording",
            recordingId: "rec-1",
        });
        await expect(second).resolves.toEqual({
            type: "recording",
            recordingId: "rec-1",
        });
    });

    it("carries tree changes", async () => {
        const event = nextEvent();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await notifyOrgChange({ type: "tree" });
        await expect(event).resolves.toEqual({ type: "tree" });
    });
});
