import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));

vi.mock("@/db", () => ({ db: { delete: vi.fn() } }));

import { db } from "@/db";
import { people } from "@/db/schema";
import { deletePerson } from "@/lib/knowledge/people";
import { exprReferencesColumn } from "../fixtures/drizzle-expr";

function captureDelete(): { table: unknown; where: unknown } {
    const captured: { table: unknown; where: unknown } = {
        table: undefined,
        where: undefined,
    };
    (db.delete as Mock).mockImplementation((table: unknown) => {
        captured.table = table;
        return {
            where: vi.fn(async (where: unknown) => {
                captured.where = where;
            }),
        };
    });
    return captured;
}

describe("deletePerson", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("erases only the session user's own person", async () => {
        const captured = captureDelete();

        await deletePerson("user-1", "person-1");

        expect(captured.table).toBe(people);
        expect(exprReferencesColumn(captured.where, people.userId)).toBe(true);
        expect(exprReferencesColumn(captured.where, people.id)).toBe(true);
    });

    it("erases the tombstones of everyone merged into them", async () => {
        const captured = captureDelete();

        await deletePerson("user-1", "person-1");

        expect(exprReferencesColumn(captured.where, people.mergedIntoId)).toBe(
            true,
        );
    });
});
