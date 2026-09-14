import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));

vi.mock("@/db", () => ({ db: { select: vi.fn() } }));

import { db } from "@/db";
import { people, transcriptSpeakers } from "@/db/schema";
import {
    buildNameResolver,
    getTranscriptSpeakers,
} from "@/lib/knowledge/attribution";
import { buildResolverMap } from "@/lib/knowledge/project-transcript";
import { exprBindsValue, exprReferencesColumn } from "../fixtures/drizzle-expr";

interface Captured {
    joins: unknown[];
    where: unknown;
}

/** Records the join and `where` expressions of the next `db.select()`. */
function captureQuery(rows: unknown[] = []): Captured {
    const captured: Captured = { joins: [], where: undefined };
    const node: Record<string, unknown> = {};
    const join = vi.fn((_table: unknown, on: unknown) => {
        captured.joins.push(on);
        return node;
    });
    node.from = vi.fn(() => node);
    node.leftJoin = join;
    node.innerJoin = join;
    node.where = vi.fn((expr: unknown) => {
        captured.where = expr;
        return Promise.resolve(rows);
    });
    (db.select as Mock).mockReturnValueOnce(node);
    return captured;
}

describe("confirmed-only projection gate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("resolves names from confirmed attributions only", async () => {
        const query = captureQuery();

        await buildNameResolver("user-1", "tx-1");

        expect(
            exprReferencesColumn(query.where, transcriptSpeakers.status),
        ).toBe(true);
        expect(exprBindsValue(query.where, "confirmed")).toBe(true);
        expect(
            exprReferencesColumn(query.where, transcriptSpeakers.userId),
        ).toBe(true);
        expect(
            exprReferencesColumn(
                query.where,
                transcriptSpeakers.transcriptionId,
            ),
        ).toBe(true);
    });

    it("applies the same gate to the batched resolver map", async () => {
        const query = captureQuery();

        await buildResolverMap("user-1", ["tx-1", "tx-2"]);

        expect(
            exprReferencesColumn(query.where, transcriptSpeakers.status),
        ).toBe(true);
        expect(exprBindsValue(query.where, "confirmed")).toBe(true);
        expect(
            exprReferencesColumn(query.where, transcriptSpeakers.userId),
        ).toBe(true);
    });

    it("does not query at all for an empty transcript list", async () => {
        expect(await buildResolverMap("user-1", [])).toEqual(new Map());
        expect(db.select).not.toHaveBeenCalled();
    });

    it("lists every attribution of one transcript, gate included or not", async () => {
        // The UI read deliberately shows suggestions as suggestions, so it is
        // the one place a non-confirmed row is allowed through.
        const query = captureQuery();

        await getTranscriptSpeakers("user-1", "tx-1");

        expect(
            exprReferencesColumn(query.where, transcriptSpeakers.userId),
        ).toBe(true);
        expect(exprBindsValue(query.where, "confirmed")).toBe(false);
    });

    it("joins people on the owning user as well as the id", async () => {
        const listing = captureQuery();
        await getTranscriptSpeakers("user-1", "tx-1");
        const resolver = captureQuery();
        await buildNameResolver("user-1", "tx-1");
        const map = captureQuery();
        await buildResolverMap("user-1", ["tx-1"]);

        const joins = [...listing.joins, ...resolver.joins, ...map.joins];
        expect(joins).toHaveLength(3);
        expect(
            joins.every((on) => exprReferencesColumn(on, people.userId)),
        ).toBe(true);
        expect(joins.every((on) => exprReferencesColumn(on, people.id))).toBe(
            true,
        );
    });
});
