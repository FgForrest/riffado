import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

import {
    DELETE as deletePersonRoute,
    GET as getPersonRoute,
    POST as mergePersonRoute,
} from "@/app/api/people/[id]/route";
import { GET as listPeopleRoute } from "@/app/api/people/route";
import { db } from "@/db";
import { people } from "@/db/schema";
import { exprReferencesColumn } from "../fixtures/drizzle-expr";

const OWN_ID = "person-mine";
const FOREIGN_ID = "person-theirs";

function personRow(id: string) {
    return {
        id,
        displayName: "Jan",
        primaryEmail: null,
        notes: null,
        mergedIntoId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

/** Answer successive `select`s from a queue, so one call can differ from the next. */
function queueSelect(results: unknown[][]): void {
    let call = 0;
    (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
            where: vi.fn(() => {
                const rows = results[call++] ?? [];
                return {
                    limit: vi.fn().mockResolvedValue(rows),
                    orderBy: vi.fn().mockResolvedValue(rows),
                };
            }),
        }),
    }));
}

/**
 * Answer every `select` with `rows`, recording the `where` expression each
 * lookup was built with. A mock answers any query the same way, so the
 * expression is the only thing that can prove the ownership filter is there.
 */
function stubSelect(rows: unknown[]): { wheres: unknown[] } {
    const wheres: unknown[] = [];
    (db.select as Mock).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
            where: vi.fn((expr: unknown) => {
                wheres.push(expr);
                return {
                    limit: vi.fn().mockResolvedValue(rows),
                    orderBy: vi.fn().mockResolvedValue(rows),
                };
            }),
        }),
    }));
    return { wheres };
}

function request(url = "http://localhost/api/people/person-mine"): Request {
    return new Request(url);
}

function context(id: string) {
    return { params: Promise.resolve({ id }) };
}

describe("people routes and ownership", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("reports the person a merge landed on, not the tombstone it named", async () => {
        const tombstone = {
            ...personRow("person-stale"),
            mergedIntoId: "person-live",
        };
        const live = { ...personRow("person-live"), displayName: "Novotny" };
        // The loser, the named target, then the person the merge resolved to.
        queueSelect([[personRow(OWN_ID)], [tombstone], [live]]);
        (db.transaction as Mock).mockResolvedValue(undefined);

        const response = await mergePersonRoute(
            new Request("http://localhost/api/people/person-mine", {
                method: "POST",
                body: JSON.stringify({ mergeIntoId: "person-stale" }),
            }),
            context(OWN_ID) as never,
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as { person: { id: string } };
        expect(body.person.id).toBe("person-live");
    });

    it("scopes the person lookup by userId and 404s on somebody else's", async () => {
        const { wheres } = stubSelect([]);

        const response = await getPersonRoute(
            request(),
            context(FOREIGN_ID) as never,
        );

        expect(response.status).toBe(404);
        expect(exprReferencesColumn(wheres[0], people.userId)).toBe(true);
        expect(exprReferencesColumn(wheres[0], people.id)).toBe(true);
    });

    it("hides tombstones from the list and scopes it by userId", async () => {
        const { wheres } = stubSelect([]);

        await listPeopleRoute(request("http://localhost/api/people"));

        expect(exprReferencesColumn(wheres[0], people.userId)).toBe(true);
        expect(exprReferencesColumn(wheres[0], people.mergedIntoId)).toBe(true);
    });

    it("refuses to erase a person the session user does not own", async () => {
        stubSelect([]);

        const response = await deletePersonRoute(
            request(),
            context(FOREIGN_ID) as never,
        );

        expect(response.status).toBe(404);
        expect(db.delete).not.toHaveBeenCalled();
    });

    it("scopes the erase itself by userId as well as by id", async () => {
        stubSelect([personRow(OWN_ID)]);
        let deleteWhere: unknown;
        (db.delete as Mock).mockReturnValue({
            where: vi.fn(async (expr: unknown) => {
                deleteWhere = expr;
            }),
        });

        const response = await deletePersonRoute(
            request(),
            context(OWN_ID) as never,
        );

        expect(response.status).toBe(200);
        expect(exprReferencesColumn(deleteWhere, people.userId)).toBe(true);
        expect(exprReferencesColumn(deleteWhere, people.id)).toBe(true);
    });

    it("refuses a merge into a person the session user does not own", async () => {
        // The first lookup finds the caller's own person, the second -- the
        // merge target -- finds nothing, because it is somebody else's.
        const wheres: unknown[] = [];
        let call = 0;
        (db.select as Mock).mockImplementation(() => ({
            from: vi.fn().mockReturnValue({
                where: vi.fn((expr: unknown) => {
                    wheres.push(expr);
                    const rows = call++ === 0 ? [personRow(OWN_ID)] : [];
                    return { limit: vi.fn().mockResolvedValue(rows) };
                }),
            }),
        }));

        const response = await mergePersonRoute(
            new Request("http://localhost/api/people/person-mine", {
                method: "POST",
                body: JSON.stringify({ mergeIntoId: FOREIGN_ID }),
            }),
            context(OWN_ID) as never,
        );

        expect(response.status).toBe(404);
        expect(db.transaction).not.toHaveBeenCalled();
        expect(
            wheres.every((expr) => exprReferencesColumn(expr, people.userId)),
        ).toBe(true);
    });

    it("refuses to merge a person into themselves", async () => {
        stubSelect([personRow(OWN_ID)]);

        const response = await mergePersonRoute(
            new Request("http://localhost/api/people/person-mine", {
                method: "POST",
                body: JSON.stringify({ mergeIntoId: OWN_ID }),
            }),
            context(OWN_ID) as never,
        );

        expect(response.status).toBe(400);
        expect(db.transaction).not.toHaveBeenCalled();
    });
});
