import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));

vi.mock("@/db", () => ({ db: { transaction: vi.fn() } }));

import { db } from "@/db";
import { people, transcriptSpeakers } from "@/db/schema";
import { mergePeople } from "@/lib/knowledge/people";
import { exprReferencesColumn } from "../fixtures/drizzle-expr";

const USER = "user-1";
const KEEP = "person-keep";
const LOSER = "person-loser";
const FINAL = "person-final";

interface Write {
    table: unknown;
    values?: Record<string, unknown>;
    where: unknown;
}

interface Harness {
    deletes: Write[];
    updates: Write[];
}

interface SpeakerRow {
    id: string;
    transcriptionId: string;
    label: string;
    status: string;
}

/**
 * Stub the merge transaction: the winner lookup, then the winner's and the
 * loser's attributions, then whatever writes the merge decides on.
 */
function stubTransaction(opts: {
    keepRow: { id: string; mergedIntoId: string | null } | null;
    winners?: SpeakerRow[];
    losers?: SpeakerRow[];
}): Harness {
    const harness: Harness = { deletes: [], updates: [] };
    const answers: unknown[][] = [
        opts.keepRow ? [opts.keepRow] : [],
        opts.winners ?? [],
        opts.losers ?? [],
    ];
    let call = 0;

    const tx = {
        select: vi.fn(() => {
            const rows = answers[call++] ?? [];
            // A real promise with `.limit` assigned onto it resolves whether
            // the caller ends the chain or awaits the `where` directly.
            const afterWhere = Object.assign(Promise.resolve(rows), {
                limit: vi.fn().mockResolvedValue(rows),
            });
            return {
                from: vi.fn().mockReturnValue({
                    where: vi.fn().mockReturnValue(afterWhere),
                }),
            };
        }),
        delete: vi.fn((table: unknown) => ({
            where: vi.fn(async (where: unknown) => {
                harness.deletes.push({ table, where });
            }),
        })),
        update: vi.fn((table: unknown) => ({
            set: vi.fn((values: Record<string, unknown>) => ({
                where: vi.fn(async (where: unknown) => {
                    harness.updates.push({ table, values, where });
                }),
            })),
        })),
    };

    (db.transaction as Mock).mockImplementation(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
            callback(tx),
    );
    return harness;
}

function speaker(id: string, label: string): SpeakerRow {
    return {
        id,
        transcriptionId: "tx-1",
        label,
        status: "confirmed",
    };
}

describe("mergePeople", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("scopes every write it issues by userId", async () => {
        const harness = stubTransaction({
            keepRow: { id: KEEP, mergedIntoId: null },
            winners: [speaker("ts-win", "speaker_0")],
            losers: [
                speaker("ts-lose-same", "speaker_0"),
                speaker("ts-lose-other", "speaker_1"),
            ],
        });

        await mergePeople(USER, KEEP, LOSER);

        for (const write of harness.deletes) {
            expect(
                exprReferencesColumn(write.where, transcriptSpeakers.userId),
            ).toBe(true);
        }
        for (const write of harness.updates) {
            const column =
                write.table === people
                    ? people.userId
                    : transcriptSpeakers.userId;
            expect(exprReferencesColumn(write.where, column)).toBe(true);
        }
        expect(harness.deletes.length + harness.updates.length).toBeGreaterThan(
            0,
        );
    });

    it("repoints the loser's free labels onto the winner", async () => {
        const harness = stubTransaction({
            keepRow: { id: KEEP, mergedIntoId: null },
            winners: [],
            losers: [speaker("ts-lose", "speaker_1")],
        });

        await mergePeople(USER, KEEP, LOSER);

        const repoint = harness.updates.find(
            (write) => write.table === transcriptSpeakers,
        );
        expect(repoint?.values).toMatchObject({ personId: KEEP });
    });

    it("collapses an existing chain onto the surviving person", async () => {
        const harness = stubTransaction({
            keepRow: { id: KEEP, mergedIntoId: null },
        });

        await mergePeople(USER, KEEP, LOSER);

        const peopleUpdates = harness.updates.filter(
            (write) => write.table === people,
        );
        expect(peopleUpdates).toHaveLength(2);
        // The loser becomes a tombstone, and anything already pointing at the
        // loser is repointed in the same transaction.
        expect(peopleUpdates[0].values).toMatchObject({ mergedIntoId: KEEP });
        expect(exprReferencesColumn(peopleUpdates[0].where, people.id)).toBe(
            true,
        );
        expect(peopleUpdates[1].values).toMatchObject({ mergedIntoId: KEEP });
        expect(
            exprReferencesColumn(peopleUpdates[1].where, people.mergedIntoId),
        ).toBe(true);
    });

    it("does nothing when a person is merged into themselves", async () => {
        stubTransaction({ keepRow: { id: KEEP, mergedIntoId: null } });

        await mergePeople(USER, KEEP, KEEP);

        expect(db.transaction).not.toHaveBeenCalled();
    });

    it("follows a merged-away target to the person it redirects to", async () => {
        const harness = stubTransaction({
            keepRow: { id: KEEP, mergedIntoId: FINAL },
        });

        await mergePeople(USER, KEEP, LOSER);

        const peopleUpdates = harness.updates.filter(
            (write) => write.table === people,
        );
        expect(peopleUpdates.length).toBeGreaterThan(0);
        // Nothing is pointed at the tombstone the People list hides.
        expect(
            peopleUpdates.every(
                (write) => write.values?.mergedIntoId === FINAL,
            ),
        ).toBe(true);
    });

    it("releases the email address the tombstone no longer displays", async () => {
        const harness = stubTransaction({
            keepRow: { id: KEEP, mergedIntoId: null },
        });

        await mergePeople(USER, KEEP, LOSER);

        const tombstone = harness.updates.find(
            (write) => write.table === people,
        );
        expect(tombstone?.values).toMatchObject({ primaryEmailHash: null });
    });
});
