/**
 * Retention and the Organization, against a real PostgreSQL.
 *
 * A shared recording is one recording: while shared the Organization's
 * policy governs it (audio, transcripts, summaries) and its owner's none of
 * it but the Plaud original; after a withdrawal the owner's applies at once.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    chatterItems,
    recordingFolders,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current) {
                    throw new Error("test database was not initialized");
                }
                const value = current[property];
                return typeof value === "function"
                    ? value.bind(current)
                    : value;
            },
        },
    );
    return {
        dbProxy: proxy,
        dbRef: ref,
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));

import {
    countReapCandidates,
    dueOnWithdrawal,
    listArmedRetentionPolicies,
    listReapCandidates,
    type RetentionPolicy,
} from "@/db/queries/retention";
import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";
import { reapRecording } from "@/lib/retention/reap";
import type { StorageProvider } from "@/lib/storage/types";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const REC = "rec-old";
const DAY = 24 * 60 * 60 * 1000;

function fakeStorage(): StorageProvider & { deleted: string[] } {
    const deleted: string[] = [];
    return {
        deleted,
        uploadFile: vi.fn(),
        downloadFile: vi.fn(),
        downloadStream: vi.fn(),
        uploadStream: vi.fn(),
        exists: vi.fn().mockResolvedValue(true),
        getSignedUrl: vi.fn(),
        deleteFile: vi.fn(async (key: string) => {
            deleted.push(key);
        }),
        testConnection: vi.fn(),
    } as unknown as StorageProvider & { deleted: string[] };
}

describeWithDatabase("retention and the Organization (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let orgRootId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "org_retention",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values({ id: OWNER, email: "owner@example.test" });
        orgUserId = (await ensureOrgAccount()) ?? "";
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        orgRootId = root?.id ?? "";
        await insertRecordings(db(), {
            id: REC,
            userId: OWNER,
            deviceSn: "local",
            plaudFileId: "plaud-1",
            filename: encryptText("Old"),
            duration: 60_000,
            startTime: new Date(Date.now() - 60 * DAY),
            endTime: new Date(Date.now() - 60 * DAY),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/old.mp3`,
            plaudVersion: "1",
        });
        await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: OWNER,
                text: encryptText("text"),
                provider: "openai",
                model: "whisper-1",
                source: "riffado",
            });
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: orgRootId,
        });
    });

    const ownerAudio30: RetentionPolicy = {
        userId: OWNER,
        remoteOriginalDays: null,
        audioDays: 30,
        transcriptDays: null,
        summaryDays: null,
    };

    const ownerAll30: RetentionPolicy = {
        ...ownerAudio30,
        transcriptDays: 30,
        summaryDays: 30,
    };

    async function orgPolicy(days: {
        audio?: number;
        transcript?: number;
    }): Promise<RetentionPolicy> {
        await db()
            .update(userSettings)
            .set({
                retentionLocalAudioDays: days.audio ?? null,
                retentionLocalTranscriptDays: days.transcript ?? null,
                retentionRemoteOriginalDays: 1,
            })
            .where(eq(userSettings.userId, orgUserId));
        const [policy] = (await listArmedRetentionPolicies(10)).filter(
            (candidate) => candidate.isOrg,
        );
        return policy as RetentionPolicy;
    }

    async function markers() {
        const [recording] = await db()
            .select({
                audio: recordings.audioReapedAt,
                transcript: chatterItems.contentReapedAt,
            })
            .from(recordings)
            .innerJoin(chatterItems, eq(chatterItems.id, recordings.id))
            .where(eq(recordings.id, REC));
        return {
            audio: recording?.audio !== null,
            transcript: recording?.transcript !== null,
        };
    }

    it("leaves a shared recording to the Organization's policy, whatever the owner's says", async () => {
        expect(
            await listReapCandidates(ownerAll30, new Date(), 10, orgUserId),
        ).toEqual([]);
        // The owner's Plaud original is theirs, shared or not.
        expect(
            await listReapCandidates(
                { ...ownerAll30, remoteOriginalDays: 30 },
                new Date(),
                10,
                orgUserId,
            ),
        ).toEqual([]);
    });

    it("lets the Organization's policy reap a shared recording's audio and rows, and mark them", async () => {
        const policy = await orgPolicy({ audio: 45, transcript: 30 });
        // Plaud originals are their owners' Plaud accounts.
        expect(policy).toMatchObject({
            remoteOriginalDays: null,
            audioDays: 45,
            transcriptDays: 30,
        });
        const [candidate] = await listReapCandidates(
            policy,
            new Date(),
            10,
            orgUserId,
        );
        const storage = fakeStorage();
        const outcome = await reapRecording(
            storage,
            policy,
            candidate as NonNullable<typeof candidate>,
            new Date(),
            orgUserId,
        );

        expect(outcome.reaped.sort()).toEqual(["audio", "transcript"]);
        expect(storage.deleted).toEqual([`${OWNER}/old.mp3`]);
        expect(await db().select().from(transcriptions)).toEqual([]);
        // The markers describe the one recording, so its owner's sync and
        // auto-transcription leave it alone after a withdrawal too.
        expect(await markers()).toEqual({ audio: true, transcript: true });
    });

    it("reaps nothing of a recording the Organization no longer has", async () => {
        const policy = await orgPolicy({ transcript: 30 });
        await unshareRecording(OWNER, REC, { withdraw: true });

        expect(
            await listReapCandidates(policy, new Date(), 10, orgUserId),
        ).toEqual([]);
    });

    it("applies the owner's policy at once after a withdrawal", async () => {
        await unshareRecording(OWNER, REC, { withdraw: true });

        const [candidate] = await listReapCandidates(
            ownerAll30,
            new Date(),
            10,
            orgUserId,
        );
        const storage = fakeStorage();
        const outcome = await reapRecording(
            storage,
            ownerAll30,
            candidate as NonNullable<typeof candidate>,
            new Date(),
            orgUserId,
        );
        expect(outcome.reaped.sort()).toEqual(["audio", "transcript"]);
    });

    it("selects an unshared recording past its shortest period only", async () => {
        await unshareRecording(OWNER, REC, { withdraw: true });
        const transcriptDue: RetentionPolicy = {
            ...ownerAudio30,
            audioDays: 90,
            transcriptDays: 45,
        };
        const nothingDue: RetentionPolicy = {
            ...transcriptDue,
            transcriptDays: 90,
        };

        expect(
            (
                await listReapCandidates(
                    transcriptDue,
                    new Date(),
                    10,
                    orgUserId,
                )
            ).map((candidate) => candidate.id),
        ).toEqual([REC]);
        expect(
            await countReapCandidates(transcriptDue, Date.now(), orgUserId),
        ).toBe(1);
        expect(
            await listReapCandidates(nothingDue, new Date(), 10, orgUserId),
        ).toEqual([]);
        expect(
            await countReapCandidates(nothingDue, Date.now(), orgUserId),
        ).toBe(0);
    });

    it("leaves a recording shared after the sweep chose it", async () => {
        await unshareRecording(OWNER, REC, { withdraw: true });
        const [candidate] = await listReapCandidates(
            ownerAll30,
            new Date(),
            10,
            orgUserId,
        );
        // Shared again between the sweep's choice and its deletes.
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: orgRootId,
        });

        const storage = fakeStorage();
        const outcome = await reapRecording(
            storage,
            ownerAll30,
            candidate as NonNullable<typeof candidate>,
            new Date(),
            orgUserId,
        );

        expect(outcome.reaped).toEqual([]);
        expect(storage.deleted).toEqual([]);
        expect(await db().select().from(transcriptions)).toHaveLength(1);
        expect(await markers()).toEqual({ audio: false, transcript: false });
    });
    it("tells the owner what their policy will delete once the recording is withdrawn", async () => {
        await db()
            .insert(userSettings)
            .values({
                userId: OWNER,
                retentionLocalAudioDays: 30,
                retentionLocalTranscriptDays: 90,
                retentionLocalSummaryDays: 30,
            })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: {
                    retentionLocalAudioDays: 30,
                    retentionLocalTranscriptDays: 90,
                    retentionLocalSummaryDays: 30,
                },
            });

        // 60 days old: past the audio period, not the transcript's; there
        // is no summary to delete.
        expect(await dueOnWithdrawal(REC, OWNER)).toEqual([
            { kind: "audio", days: 30 },
        ]);
    });
});
