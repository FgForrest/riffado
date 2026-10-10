/**
 * Sync and a shared recording: it is the organization account's to change,
 * so Plaud's transcript would be refused and its summary is imported only
 * beside that transcript. Nothing is fetched from Plaud for them while it is
 * shared, and both are imported once it is not; a new Plaud version of it
 * waits the same way. (Review 1B, finding H; the harness is the one of the
 * #274 regression test.)
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { sharing } = vi.hoisted(() => ({ sharing: { shared: true } }));

vi.mock("@/lib/env", () => ({
    env: {
        DEFAULT_STORAGE_TYPE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        uploadFile: vi.fn().mockResolvedValue(undefined),
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("audio-data")),
    }),
}));

vi.mock("@/lib/notifications/bark", () => ({
    sendNewRecordingBarkNotification: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/notifications/email", () => ({
    sendNewRecordingEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/transcription/transcribe-recording", () => ({
    transcribeRecording: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/transcription/persist", () => ({
    upsertTranscription: vi.fn().mockResolvedValue({ committed: true }),
    upsertEnhancement: vi.fn().mockResolvedValue({ committed: true }),
}));

vi.mock("@/lib/org/config", () => ({
    getOrgUserId: vi.fn().mockResolvedValue("org-user"),
    isOrgScopeEnabled: () => true,
    isOrgScopeVisible: () => true,
}));

vi.mock("@/lib/sharing/shared", async () => {
    const { sql } =
        await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
    return {
        // Every recording of this user is shared, or none is.
        isRecordingShared: vi.fn(async () => sharing.shared),
        sharedRecordingCondition: () => sql`true`,
    };
});

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "@/db";
import {
    aiEnhancements,
    plaudConnections,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { createPlaudClient } from "@/lib/plaud/client-factory";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { resetAutoTranscribeStateForTests } from "@/lib/sync/auto-transcribe-state";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";
import {
    upsertEnhancement,
    upsertTranscription,
} from "@/lib/transcription/persist";

const USER_ID = "user-shared";
const PAGE_SIZE = 50;

type Fixture = {
    rec: ReturnType<typeof plaudRecording>;
    deletedAt?: Date | null;
    hasPlaudTranscript?: boolean;
    hasSummary?: boolean;
    deviceSn?: string;
};

function plaudRecording(
    index: number,
    overrides: {
        is_trans?: boolean;
        is_summary?: boolean;
        version_ms?: number;
    } = {},
) {
    return {
        id: `plaud-${index}`,
        filename: `Recording ${index}.mp3`,
        duration: 60000,
        start_time: "2024-01-01T10:00:00Z",
        end_time: "2024-01-01T10:01:00Z",
        filesize: 1024000,
        file_md5: `md5-${index}`,
        serial_number: "SN123",
        version_ms: overrides.version_ms ?? 1000,
        timezone: 0,
        zonemins: 0,
        scene: 0,
        is_trash: false,
        is_trans: overrides.is_trans ?? true,
        is_summary: overrides.is_summary ?? false,
    };
}

function fixture(
    index: number,
    opts: {
        deletedAt?: Date | null;
        hasPlaudTranscript?: boolean;
        hasSummary?: boolean;
        is_summary?: boolean;
        deviceSn?: string;
    } = {},
): Fixture {
    return {
        rec: plaudRecording(index, { is_summary: opts.is_summary }),
        deletedAt: opts.deletedAt,
        hasPlaudTranscript: opts.hasPlaudTranscript,
        hasSummary: opts.hasSummary,
        deviceSn: opts.deviceSn,
    };
}

function walkStrings(clause: unknown): string[] {
    const out: string[] = [];
    const seen = new Set<unknown>();
    const stack: unknown[] = [clause];
    while (stack.length > 0) {
        const cur = stack.pop();
        if (cur == null || seen.has(cur)) continue;
        if (typeof cur === "string") {
            out.push(cur);
            continue;
        }
        if (typeof cur !== "object") continue;
        seen.add(cur);
        if (Array.isArray(cur)) stack.push(...cur);
        else stack.push(...Object.values(cur as Record<string, unknown>));
    }
    return out;
}

function collectLocalIds(clause: unknown): Set<string> {
    return new Set(walkStrings(clause).filter((s) => s.startsWith("local-")));
}

function findLocalId(clause: unknown): string | undefined {
    return walkStrings(clause).find((s) => s.startsWith("local-"));
}

function readyDetail(fileId: string, opts: { summary?: boolean } = {}) {
    const content_list = [
        {
            data_id: `source_transaction:${fileId}`,
            data_type: "transaction",
            task_status: 1,
            data_link: `https://s3.example/${fileId}.json`,
        },
    ];
    const pre_download_content_list: {
        data_id: string;
        data_content: string;
    }[] = [];
    if (opts.summary) {
        const dataId = `auto_sum:${fileId}`;
        content_list.push({
            data_id: dataId,
            data_type: "auto_sum_note",
            task_status: 1,
            data_link: `https://s3.example/${fileId}-sum.json`,
        });
        pre_download_content_list.push({
            data_id: dataId,
            data_content: JSON.stringify({ summary: "imported summary" }),
        });
    }
    return {
        status: 0,
        data: {
            file_id: fileId,
            content_list,
            pre_download_content_list,
        },
    };
}

function mockSelects(opts: {
    importPlaudContent: boolean;
    fixtures: Fixture[];
}) {
    const byLocalId = new Map(
        opts.fixtures.map((f) => [`local-${f.rec.id}`, f]),
    );
    const plaudFixtures = opts.fixtures.filter((f) => f.deviceSn !== "local");
    let recordingLookup = 0;

    (db.select as Mock).mockImplementation(() => {
        let table: unknown;
        let joined = false;
        let whereClause: unknown;
        const chain = {
            from: (next: unknown) => {
                table = next;
                return chain;
            },
            // Every recording read joins its item; only the content-gap
            // probe left-joins the transcripts and summaries.
            innerJoin: () => chain,
            leftJoin: () => {
                joined = true;
                return chain;
            },
            where: (clause?: unknown) => {
                whereClause = clause;
                return chain;
            },
            limit: () => {
                if (table === plaudConnections) {
                    return Promise.resolve([
                        {
                            id: "conn-1",
                            userId: USER_ID,
                            bearerToken: "encrypted-token",
                        },
                    ]);
                }
                if (table === userSettings) {
                    return Promise.resolve([
                        { importPlaudContent: opts.importPlaudContent },
                    ]);
                }
                if (table === users) {
                    return Promise.resolve([{ email: "test@example.com" }]);
                }
                if (table === recordings) {
                    if (joined) {
                        const seenIds = collectLocalIds(whereClause);
                        const excludeLocalUploads =
                            walkStrings(whereClause).includes("local");
                        const unseen = opts.fixtures.find(
                            (f) =>
                                (!excludeLocalUploads ||
                                    f.deviceSn !== "local") &&
                                !f.deletedAt &&
                                (!f.hasPlaudTranscript || !f.hasSummary) &&
                                !seenIds.has(`local-${f.rec.id}`),
                        );
                        return Promise.resolve(
                            unseen ? [{ id: `local-${unseen.rec.id}` }] : [],
                        );
                    }
                    // "Is this audio key another recording's?" No.
                    if (
                        walkStrings(whereClause).some((value) =>
                            value.endsWith(".mp3"),
                        )
                    ) {
                        return Promise.resolve([]);
                    }
                    const f = plaudFixtures[recordingLookup++];
                    if (!f) return Promise.resolve([]);
                    return Promise.resolve([
                        {
                            recording: {
                                id: `local-${f.rec.id}`,
                                plaudFileId: f.rec.id,
                                plaudVersion: "1000",
                                storagePath: `${USER_ID}/${f.rec.id}.mp3`,
                                deletedAt: f.deletedAt ?? null,
                            },
                            contentReapedAt: null,
                            summaryReapedAt: null,
                        },
                    ]);
                }
                if (table === transcriptions) {
                    const localId = findLocalId(whereClause);
                    const f = localId ? byLocalId.get(localId) : undefined;
                    if (f?.hasPlaudTranscript) {
                        return Promise.resolve([{ id: `tr-${f.rec.id}` }]);
                    }
                    return Promise.resolve([]);
                }
                if (table === aiEnhancements) {
                    const localId = findLocalId(whereClause);
                    const f = localId ? byLocalId.get(localId) : undefined;
                    if (f?.hasSummary) {
                        return Promise.resolve([{ id: `sum-${f.rec.id}` }]);
                    }
                    return Promise.resolve([]);
                }
                return Promise.resolve([]);
            },
        };
        return chain;
    });
}

function mockPlaudPages(
    pages: ReturnType<typeof plaudRecording>[][],
    extras: {
        getFileDetail?: Mock;
        fetchContentLink?: Mock;
    } = {},
) {
    const getRecordings = vi.fn(async (skip: number) => {
        const pageIndex = skip / PAGE_SIZE;
        return { data_file_list: pages[pageIndex] ?? [] };
    });
    const getFileDetail =
        extras.getFileDetail ??
        vi.fn(async (fileId: string) => readyDetail(fileId));
    const fetchContentLink =
        extras.fetchContentLink ??
        vi.fn(async () => [{ speaker: 1, content: "hello from plaud" }]);
    const downloadRecording = vi.fn();
    (createPlaudClient as Mock).mockResolvedValue({
        getRecordings,
        getFileDetail,
        fetchContentLink,
        downloadRecording,
    });
    return { getRecordings, getFileDetail, downloadRecording };
}

describe("sync of a shared recording", () => {
    beforeEach(() => {
        resetAutoTranscribeStateForTests();
        vi.clearAllMocks();
        sharing.shared = true;
        (db.update as Mock).mockReturnValue({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
            }),
        });
    });

    async function syncTwice(recording: Fixture) {
        const { getFileDetail } = mockPlaudPages([[recording.rec]], {
            getFileDetail: vi.fn(async (fileId: string) =>
                readyDetail(fileId, { summary: true }),
            ),
        });
        for (let run = 0; run < 2; run += 1) {
            mockSelects({ importPlaudContent: true, fixtures: [recording] });
            await syncRecordingsForUser(USER_ID);
        }
        return getFileDetail;
    }

    it("fetches nothing from Plaud for its transcript and summary while it is shared", async () => {
        const getFileDetail = await syncTwice(fixture(0, { is_summary: true }));

        expect(getFileDetail).not.toHaveBeenCalled();
        expect(upsertTranscription).not.toHaveBeenCalled();
        expect(upsertEnhancement).not.toHaveBeenCalled();
    });

    it("imports them once it is no longer shared", async () => {
        sharing.shared = false;

        const getFileDetail = await syncTwice(fixture(0, { is_summary: true }));

        expect(getFileDetail).toHaveBeenCalled();
        expect(upsertTranscription).toHaveBeenCalledWith(
            expect.objectContaining({ source: "plaud" }),
        );
    });

    it("still imports the summary of a Plaud transcript it already has", async () => {
        const getFileDetail = await syncTwice(
            fixture(0, { is_summary: true, hasPlaudTranscript: true }),
        );

        expect(getFileDetail).toHaveBeenCalled();
        expect(upsertTranscription).not.toHaveBeenCalled();
    });

    it("leaves a new Plaud version of it for after the withdrawal", async () => {
        const updated = fixture(0);
        updated.rec = plaudRecording(0, { version_ms: 2000 });
        const sync = async () => {
            const { downloadRecording } = mockPlaudPages([[updated.rec]]);
            mockSelects({ importPlaudContent: false, fixtures: [updated] });
            await syncRecordingsForUser(USER_ID);
            return downloadRecording;
        };

        expect(await sync()).not.toHaveBeenCalled();

        sharing.shared = false;
        expect(await sync()).toHaveBeenCalledWith("plaud-0", false);
    });

    it("writes no new Plaud version over its audio when it is shared during the download", async () => {
        sharing.shared = false;
        const updated = fixture(0);
        updated.rec = plaudRecording(0, { version_ms: 2000 });
        const { downloadRecording } = mockPlaudPages([[updated.rec]]);
        downloadRecording.mockImplementation(async () => {
            sharing.shared = true;
            return Buffer.from("new audio");
        });
        const storage = await createUserStorageProvider(USER_ID);
        const lock = {
            from: () => lock,
            innerJoin: () => lock,
            where: () => lock,
            for: () => lock,
            limit: async () => [{ deletedAt: null, titleEditedAt: null }],
        };
        const txUpdate = vi.fn();
        (db.transaction as Mock).mockImplementation(
            async (run: (tx: unknown) => Promise<unknown>) =>
                run({ select: () => lock, update: txUpdate }),
        );
        mockSelects({ importPlaudContent: false, fixtures: [updated] });

        await syncRecordingsForUser(USER_ID);

        expect(downloadRecording).toHaveBeenCalled();
        // Its audio and its row stay as they were shared.
        expect(storage.uploadFile).not.toHaveBeenCalled();
        expect(txUpdate).not.toHaveBeenCalled();
    });
});
