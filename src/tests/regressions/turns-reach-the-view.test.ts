/**
 * Stored turns have to survive the same two hops that `source` and `model`
 * once failed (see `transcript-provenance-reaches-view.test.ts`).
 *
 * There are two independent SSR loaders that decrypt transcript text --
 * `app/(app)/dashboard/page.tsx` and `app/(app)/recordings/[id]/page.tsx` --
 * and both feed the same `TranscriptView`. A loader that selects `turns` but
 * does not pass it, or passes it but does not select it, degrades silently:
 * the regex fallback still produces a readable dialog, so nothing errors and
 * nothing looks wrong. The only visible difference is that the turns carry
 * timings and the regex cannot, which is exactly what the knowledge base
 * needs and exactly what nobody would notice missing.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/db", () => ({ db: { select: vi.fn() } }));

vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));

vi.mock("@/lib/auth-server", () => ({
    requireAuth: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", email: "a@b.c" } }),
    requireCompletedOnboarding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/hosted/admin/guard", () => ({
    isAdminEmail: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/folders/folders", () => ({
    listFolderOrganization: vi.fn().mockResolvedValue({
        folders: [],
        assignments: [],
    }),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string | null) => value,
    decryptJsonField: (value: unknown) => value,
}));

// The loaders are the subject; the client trees they hand their props to
// are not, and rendering them here would pull in the whole workstation.
vi.mock("@/components/dashboard/workstation", () => ({
    Workstation: function Workstation() {
        return null;
    },
}));

vi.mock("@/components/recordings/recording-workstation", () => ({
    RecordingWorkstation: function RecordingWorkstation() {
        return null;
    },
}));

vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("notFound");
    },
}));

import DashboardPage from "@/app/(app)/dashboard/page";
import RecordingDetailPage from "@/app/(app)/recordings/[id]/page";
import { toTranscriptList } from "@/components/dashboard/transcription-panel";
import { db } from "@/db";
import { transcriptions } from "@/db/schema";
import type { TranscriptTurn } from "@/lib/transcription/turns";

const TURNS: TranscriptTurn[] = [
    { speaker: "speaker_0", startMs: 0, endMs: 1500, text: "Ahoj." },
    { speaker: "speaker_1", startMs: 1500, endMs: 3000, text: "Zdravím." },
];

const DIARIZED_TEXT = "speaker_0: Ahoj.\nspeaker_1: Zdravím.";

describe("stored turns survive the single-transcript path", () => {
    it("carries turns through toTranscriptList", () => {
        const [option] = toTranscriptList(undefined, {
            text: DIARIZED_TEXT,
            language: "ces",
            source: "riffado",
            model: "scribe_v2+diarize",
            turns: TURNS,
        });

        expect(option.turns).toEqual(TURNS);
    });

    it("leaves turns absent for a transcript that has none", () => {
        const [option] = toTranscriptList(undefined, {
            text: "Plain prose with no speakers.",
            source: "riffado",
            model: "whisper-1",
        });

        expect(option.turns).toBeUndefined();
    });

    it("prefers the explicit transcripts list when one is given", () => {
        const [option] = toTranscriptList(
            [
                {
                    source: "plaud",
                    text: DIARIZED_TEXT,
                    model: "plaud-native",
                    turns: TURNS,
                },
            ],
            undefined,
        );

        expect(option.turns).toEqual(TURNS);
    });
});

/** The projection every `db.select(...)` in a loader was built with. */
let projections: unknown[] = [];

/**
 * One `db.select()` answer that resolves whichever way a loader ends the
 * chain -- awaiting the `where`, or chaining `orderBy` or `limit` off it.
 */
function queueSelect(rows: unknown[]): void {
    const afterWhere = Object.assign(Promise.resolve(rows), {
        orderBy: () => Promise.resolve(rows),
        limit: () => Promise.resolve(rows),
    });
    const node: Record<string, unknown> = {};
    node.from = () => node;
    node.where = () => afterWhere;
    (db.select as Mock).mockImplementationOnce((projection: unknown) => {
        projections.push(projection);
        return node;
    });
}

const TRANSCRIPT_ROW = {
    id: "tr-1",
    recordingId: "rec-1",
    text: DIARIZED_TEXT,
    detectedLanguage: "ces",
    language: "ces",
    source: "riffado",
    provider: "ElevenLabs",
    model: "scribe_v2+diarize",
    turns: TURNS,
};

const RECORDING_ROW = {
    id: "rec-1",
    userId: "user-1",
    filename: "Board meeting",
    duration: 60_000,
    startTime: new Date("2026-09-11T18:42:00.000Z"),
    filesize: 100,
    deviceSn: "SN-1",
    waveformPeaks: null,
    audioReapedAt: null,
};

describe("stored turns survive both SSR loaders", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        projections = [];
    });

    it("selects and passes turns from the dashboard loader", async () => {
        queueSelect([RECORDING_ROW]);
        queueSelect([TRANSCRIPT_ROW]);
        queueSelect([]);
        queueSelect([]);
        queueSelect([]);

        const element = (await DashboardPage()) as {
            props: {
                transcriptions: Map<string, { turns: TranscriptTurn[] | null }>;
            };
        };

        const selected = projections[1] as Record<string, unknown>;
        expect(selected.turns).toBe(transcriptions.turns);
        expect(element.props.transcriptions.get("rec-1")?.turns).toEqual(TURNS);
    });

    it("passes turns from the single-recording loader", async () => {
        queueSelect([RECORDING_ROW]);
        queueSelect([TRANSCRIPT_ROW]);
        queueSelect([]);

        const element = (await RecordingDetailPage({
            params: Promise.resolve({ id: "rec-1" }),
        })) as {
            props: { transcripts: { turns: TranscriptTurn[] | null }[] };
        };

        expect(element.props.transcripts[0].turns).toEqual(TURNS);
    });

    it("passes no turns from the dashboard loader when the row carries none", async () => {
        queueSelect([RECORDING_ROW]);
        queueSelect([{ ...TRANSCRIPT_ROW, turns: null }]);
        queueSelect([]);
        queueSelect([]);
        queueSelect([]);

        const element = (await DashboardPage()) as {
            props: {
                transcriptions: Map<string, { turns: TranscriptTurn[] | null }>;
            };
        };

        expect(element.props.transcriptions.get("rec-1")?.turns).toBeNull();
    });
});
