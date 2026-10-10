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

// Carrying speaker rows and corrections over is tested against a real
// database (`attribution-remap`, `corrections` integration tests); here
// only that it happens.
vi.mock("@/lib/knowledge/transcript-rewrite", () => ({
    transcriptRewrittenInTx: vi.fn(),
    stampNewTranscriptAudioInTx: vi.fn(),
}));
vi.mock("@/lib/knowledge/speaker-labels", () => ({
    storedSpeakerVersion: () => ({ turns: null, labels: ["speaker_0"] }),
}));
// Whether a recording is shared is tested against a real database
// (`freeze.integration.test.ts`); here only what the write does with it.
vi.mock("@/lib/sharing/writer", async () => ({
    ...(await vi.importActual<typeof import("@/lib/sharing/writer-rule")>(
        "@/lib/sharing/writer-rule",
    )),
    sharingOrgUserId: vi.fn(async () => "org-account"),
}));
vi.mock("@/lib/sharing/shared", () => ({
    isRecordingShared: vi.fn(async () => false),
}));

import { db } from "@/db";
import { chatterItems } from "@/db/schema";
import { transcriptRewrittenInTx } from "@/lib/knowledge/transcript-rewrite";
import { isRecordingShared } from "@/lib/sharing/shared";
import { upsertTranscription } from "@/lib/transcription/persist";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const TURNS: TranscriptTurn[] = [
    { speaker: "speaker_0", startMs: 0, endMs: 1000, text: "Ahoj." },
];

interface Harness {
    inserted: Record<string, unknown>[];
    updated: Record<string, unknown>[];
    updatedTables: unknown[];
}

function stubTransaction(
    existing: { id: string } | null,
    recordingState: {
        deletedAt: Date | null;
        transcriptReapedAt?: Date | null;
    } = { deletedAt: null },
): Harness {
    const harness: Harness = { inserted: [], updated: [], updatedTables: [] };
    const answers: unknown[][] = [[recordingState], existing ? [existing] : []];
    let call = 0;

    const tx = {
        select: vi.fn(() => {
            const rows = answers[call++] ?? [];
            const chain: Record<string, unknown> = {};
            chain.from = () => chain;
            chain.innerJoin = () => chain;
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
        update: vi.fn((table: unknown) => ({
            set: (row: Record<string, unknown>) => ({
                where: async () => {
                    harness.updated.push(row);
                    harness.updatedTables.push(table);
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

function upsert(
    turns?: TranscriptTurn[],
    allowReaped = false,
    actorUserId?: string,
) {
    return upsertTranscription({
        userId: "user-1",
        actorUserId,
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

    it("clears topics on every write, since they were anchored to the old turns", async () => {
        const inserted = stubTransaction(null);
        await upsert(TURNS);
        expect(inserted.inserted[0]).toHaveProperty("topics", null);

        const updated = stubTransaction({ id: "tr-1" });
        await upsert(TURNS);
        expect(updated.updated[0]).toHaveProperty("topics", null);
    });

    it("clears the previous run's turns on an undiarized re-run", async () => {
        const harness = stubTransaction({ id: "tr-1" });

        await upsert();

        expect(harness.updated[0]).toHaveProperty("turns", null);
    });

    it("moves the speaker rows onto the new text, and only on an overwrite", async () => {
        stubTransaction(null);
        await upsert(TURNS);
        expect(transcriptRewrittenInTx).not.toHaveBeenCalled();

        stubTransaction({ id: "tr-1" });
        await upsert(TURNS);
        expect(transcriptRewrittenInTx).toHaveBeenCalledWith(
            expect.anything(),
            {
                userId: "user-1",
                transcriptionId: "tr-1",
                previous: { turns: null, labels: ["speaker_0"] },
                next: { turns: TURNS, labels: ["speaker_0"] },
            },
        );
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
                        chain.innerJoin = () => chain;
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

    it("writes nothing to the owner's transcript while it is shared", async () => {
        const harness = stubTransaction({ id: "tr-1" });
        (isRecordingShared as Mock).mockResolvedValueOnce(true);

        expect(await upsert(TURNS)).toEqual({
            committed: false,
            reason: "shared",
        });
        expect(harness.inserted).toHaveLength(0);
        expect(harness.updated).toHaveLength(0);
        expect(transcriptRewrittenInTx).not.toHaveBeenCalled();
    });

    it("lets the organization account rewrite a shared recording's transcript", async () => {
        const harness = stubTransaction({ id: "tr-1" });
        (isRecordingShared as Mock).mockResolvedValueOnce(true);

        expect(await upsert(TURNS, false, "org-account")).toEqual({
            committed: true,
        });
        expect(harness.updated[0]).toMatchObject({
            producedByUserId: "org-account",
        });
        expect(transcriptRewrittenInTx).toHaveBeenCalledOnce();
    });

    it("writes nothing for the organization account once the recording is withdrawn", async () => {
        const harness = stubTransaction({ id: "tr-1" });

        expect(await upsert(TURNS, false, "org-account")).toEqual({
            committed: false,
            reason: "withdrawn",
        });
        expect(harness.inserted).toHaveLength(0);
        expect(harness.updated).toHaveLength(0);
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
        expect(harness.updatedTables.at(-1)).toBe(chatterItems);
        expect(harness.updated.at(-1)).toMatchObject({
            contentReapedAt: null,
        });
    });
});
