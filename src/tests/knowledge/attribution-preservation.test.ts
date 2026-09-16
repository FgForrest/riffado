import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
    },
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string) => value,
}));

import { db } from "@/db";
import { transcriptSpeakers } from "@/db/schema";
import { copyMatchingSpeakerAttributions } from "@/lib/knowledge/attribution";

interface SpeakerRow {
    transcriptionId: string;
    transcriptionSource: string;
    transcriptionText: string;
    label: string | null;
    personId: string | null;
    source: "user" | null;
    confidence: number | null;
    evidenceStartMs: number | null;
}

const sourceRows: SpeakerRow[] = [
    {
        transcriptionId: "tx-riffado",
        transcriptionSource: "riffado",
        transcriptionText: "speaker_0: New A\nspeaker_1: New B",
        label: null,
        personId: null,
        source: null,
        confidence: null,
        evidenceStartMs: null,
    },
    {
        transcriptionId: "tx-plaud",
        transcriptionSource: "plaud",
        transcriptionText: "Speaker 0: Old A\nSpeaker 1: Old B",
        label: "Speaker 0",
        personId: "person-a",
        source: "user",
        confidence: null,
        evidenceStartMs: null,
    },
    {
        transcriptionId: "tx-plaud",
        transcriptionSource: "plaud",
        transcriptionText: "Speaker 0: Old A\nSpeaker 1: Old B",
        label: "Speaker 1",
        personId: "person-b",
        source: "user",
        confidence: null,
        evidenceStartMs: null,
    },
];

function stubRows(rows: SpeakerRow[]) {
    const chain: Record<string, Mock> = {};
    chain.from = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn().mockResolvedValue(rows);
    (db.select as Mock).mockReturnValue(chain);
}

describe("speaker attribution preservation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("copies confirmed people by speaker order when counts match", async () => {
        stubRows(sourceRows);
        const inserted: Record<string, unknown>[] = [];
        (db.insert as Mock).mockImplementation((table: unknown) => {
            expect(table).toBe(transcriptSpeakers);
            return {
                values: (rows: Record<string, unknown>[]) => {
                    inserted.push(...rows);
                    return { onConflictDoNothing: vi.fn() };
                },
            };
        });

        const copied = await copyMatchingSpeakerAttributions({
            userId: "user-1",
            recordingId: "rec-1",
            sourceSource: "plaud",
            targetSource: "riffado",
            targetText: "speaker_0: New A\nspeaker_1: New B",
        });

        expect(copied).toBe(true);
        expect(inserted).toEqual([
            expect.objectContaining({
                transcriptionId: "tx-riffado",
                label: "speaker_0",
                personId: "person-a",
                status: "confirmed",
            }),
            expect.objectContaining({
                transcriptionId: "tx-riffado",
                label: "speaker_1",
                personId: "person-b",
                status: "confirmed",
            }),
        ]);
    });

    it("does not copy assignments when the speaker count changed", async () => {
        stubRows(sourceRows);

        const copied = await copyMatchingSpeakerAttributions({
            userId: "user-1",
            recordingId: "rec-1",
            sourceSource: "plaud",
            targetSource: "riffado",
            targetText: "speaker_0: New A\nspeaker_1: New B\nspeaker_2: New C",
        });

        expect(copied).toBe(false);
        expect(db.insert).not.toHaveBeenCalled();
    });
});
