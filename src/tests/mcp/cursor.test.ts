import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { chatterItems, recordings } from "@/db/schema";
import { keysetBefore, keysetOrder } from "@/lib/db/keyset";
import {
    decodeKeyset,
    encodeKeyset,
    encodeOffset,
    parseKeyset,
    parseOffset,
} from "@/lib/mcp/cursor";
import { McpToolError } from "@/lib/mcp/errors";

const AT = new Date("2026-09-01T10:00:00.123Z");

function invalid(run: () => unknown) {
    let caught: unknown = null;
    try {
        run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).message).toBe("Invalid cursor");
    expect((caught as McpToolError).outcome).toBe("invalid");
}

const GARBAGE = [
    "",
    "not a cursor",
    "%%%",
    "a".repeat(600),
    Buffer.from("no-separator").toString("base64url"),
    Buffer.from("|id-only").toString("base64url"),
    Buffer.from("2026-09-01T10:00:00.123Z|").toString("base64url"),
    Buffer.from("yesterday|rec-1").toString("base64url"),
    Buffer.from("2026-09-01|rec-1").toString("base64url"),
    Buffer.from("2026-13-01T10:00:00.000Z|rec-1").toString("base64url"),
    Buffer.from(`2026-09-01T10:00:00.123Z|${"x".repeat(201)}`).toString(
        "base64url",
    ),
    Buffer.from("2026-09-01T10:00:00.123Z|rec\u0000").toString("base64url"),
    encodeOffset(3),
];

describe("keyset cursors", () => {
    it("round-trips a position", () => {
        const cursor = encodeKeyset({ at: AT, id: "rec|1" });
        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeKeyset(cursor)).toEqual({ at: AT, id: "rec|1" });
        expect(parseKeyset(cursor)).toEqual({ at: AT, id: "rec|1" });
    });

    it("reads no cursor as the start", () => {
        expect(parseKeyset(undefined)).toBeNull();
        expect(parseKeyset(null)).toBeNull();
    });

    it("answers garbage with Invalid cursor, never a crash", () => {
        for (const cursor of GARBAGE) {
            expect(decodeKeyset(cursor)).toBeNull();
            invalid(() => parseKeyset(cursor));
        }
    });

    it("walks newest first, to the millisecond", () => {
        const dialect = new PgDialect();
        const order = keysetOrder(chatterItems.occurredAt, recordings.id).map(
            (part) => dialect.sqlToQuery(part).sql,
        );
        expect(order).toEqual([
            `date_trunc('milliseconds', "chatter_items"."occurred_at") desc`,
            `"recordings"."id" desc`,
        ]);
        const before = dialect.sqlToQuery(
            keysetBefore(chatterItems.occurredAt, recordings.id, {
                at: AT,
                id: "rec-1",
            }),
        );
        expect(before.sql).toBe(
            `(date_trunc('milliseconds', "chatter_items"."occurred_at"), "recordings"."id") < ($1::timestamp, $2)`,
        );
        expect(before.params).toEqual(["2026-09-01T10:00:00.123Z", "rec-1"]);
    });
});

describe("offset cursors", () => {
    it("round-trips a position", () => {
        expect(parseOffset(encodeOffset(0))).toBe(0);
        expect(parseOffset(encodeOffset(150))).toBe(150);
        expect(parseOffset(undefined)).toBe(0);
    });

    it("answers garbage with Invalid cursor", () => {
        for (const cursor of [
            "",
            "zzz",
            Buffer.from("o:-1").toString("base64url"),
            Buffer.from("o:01").toString("base64url"),
            Buffer.from("o:1.5").toString("base64url"),
            Buffer.from("o:99999999").toString("base64url"),
            encodeKeyset({ at: AT, id: "rec-1" }),
        ]) {
            invalid(() => parseOffset(cursor));
        }
    });
});
