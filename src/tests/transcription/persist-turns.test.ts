/**
 * `turns` is written on every upsert, including as NULL.
 *
 * The trap is the undiarized re-run: it supplies no turns, and if the column
 * is simply left out of the statement the previous diarized run's turns stay
 * attached to text they no longer describe. Every read seam prefers stored
 * turns, so the app would then serve the superseded transcript.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/encryption/fields", () => ({
    encryptText: (value: string) => `enc:${value}`,
    encryptJsonField: <T>(value: T) => ({ c: value }),
}));

vi.mock("@/db", () => ({ db: { transaction: vi.fn() } }));

import { db } from "@/db";
import { upsertTranscription } from "@/lib/transcription/persist";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const TURNS: TranscriptTurn[] = [
    { speaker: "speaker_0", startMs: 0, endMs: 1000, text: "Ahoj." },
];

interface Harness {
    inserted: Record<string, unknown>[];
    updated: Record<string, unknown>[];
}

function stubTransaction(
    existing: { id: string } | null,
    recordingState: {
        deletedAt: Date | null;
        transcriptReapedAt?: Date | null;
    } = { deletedAt: null },
): Harness {
    const harness: Harness = { inserted: [], updated: [] };
    const answers: unknown[][] = [[recordingState], existing ? [existing] : []];
    let call = 0;

    const tx = {
        select: vi.fn(() => {
            const rows = answers[call++] ?? [];
            const chain: Record<string, unknown> = {};
            chain.from = () => chain;
            chain.where = () => chain;
            chain.for = () => chain;
            chain.limit = () => Promise.resolve(rows);
            return chain;
        }),
        insert: vi.fn(() => ({
            values: async (row: Record<string, unknown>) => {
                harness.inserted.push(row);
            },
        })),
        update: vi.fn(() => ({
            set: (row: Record<string, unknown>) => ({
                where: async () => {
                    harness.updated.push(row);
                },
            }),
        })),
    };

    (db.transaction as Mock).mockImplementation(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
            callback(tx),
    );
    return harness;
}

function upsert(turns?: TranscriptTurn[], allowReaped = false) {
    return upsertTranscription({
        userId: "user-1",
        recordingId: "rec-1",
        text: "speaker_0: Ahoj.",
        detectedLanguage: "cs",
        source: "riffado",
        provider: "speechmatics",
        model: "enhanced+diarize",
        turns,
        allowReaped,
    });
}

describe("upsertTranscription and turns", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("stores the turns a diarizing provider supplied", async () => {
        const harness = stubTransaction(null);

        await upsert(TURNS);

        expect(harness.inserted[0].turns).toEqual({ c: TURNS });
    });

    it("stores no turns when the provider supplied none", async () => {
        const harness = stubTransaction(null);

        await upsert();

        expect(harness.inserted[0].turns).toBeNull();
    });

    it("clears the previous run's turns on an undiarized re-run", async () => {
        const harness = stubTransaction({ id: "tr-1" });

        await upsert();

        expect(harness.updated[0]).toHaveProperty("turns", null);
    });

    it("treats an empty turn list as no turns at all", async () => {
        const harness = stubTransaction(null);

        // Otherwise `readTranscriptTurns` and the flat-text fallback would
        // disagree about whether this transcript is a dialog.
        await upsert([]);

        expect(harness.inserted[0].turns).toBeNull();
    });

    it("does not write at all when the recording was deleted mid-run", async () => {
        // The transaction stub offers only `select`, so reaching any write
        // would throw rather than quietly pass.
        (db.transaction as Mock).mockImplementation(
            async (
                callback: (transaction: {
                    select: () => Record<string, unknown>;
                }) => Promise<unknown>,
            ) =>
                callback({
                    select: () => {
                        const chain: Record<string, unknown> = {};
                        chain.from = () => chain;
                        chain.where = () => chain;
                        chain.for = () => chain;
                        chain.limit = () =>
                            Promise.resolve([{ deletedAt: new Date() }]);
                        return chain;
                    },
                }),
        );

        expect(await upsert(TURNS)).toEqual({ committed: false });
    });

    it("does not recreate an explicitly erased transcript automatically", async () => {
        const harness = stubTransaction(null, {
            deletedAt: null,
            transcriptReapedAt: new Date(),
        });

        expect(await upsert(TURNS)).toEqual({ committed: false });
        expect(harness.inserted).toHaveLength(0);
        expect(harness.updated).toHaveLength(0);
    });

    it("lets a manual run replace an erased transcript and clears suppression", async () => {
        const harness = stubTransaction(null, {
            deletedAt: null,
            transcriptReapedAt: new Date(),
        });

        expect(await upsert(TURNS, true)).toEqual({ committed: true });
        expect(harness.inserted).toHaveLength(1);
        expect(harness.updated.at(-1)).toMatchObject({
            transcriptReapedAt: null,
        });
    });
});
