/**
 * Retention and the Organization, against a real PostgreSQL.
 *
 * Sharing copies nothing, so a shared recording's audio is the owner's file
 * and everyone's at once. These pin the rules that keep one policy from
 * deleting what another relies on: the longer audio period wins while
 * shared, an unshare is followed by a grace period, and the organization's
 * policy touches only the Organization view's own rows.
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
    listArmedRetentionPolicies,
    listReapCandidates,
    loadOrgRetentionContext,
    type RetentionPolicy,
} from "@/db/queries/retention";
import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";
import { reapRecording } from "@/lib/retention/reap";
import type { StorageProvider } from "@/lib/storage/types";

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
        await db()
            .insert(recordings)
            .values({
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
        for (const userId of [OWNER, orgUserId]) {
            await db()
                .insert(transcriptions)
                .values({
                    recordingId: REC,
                    userId,
                    text: encryptText("text"),
                    provider: "openai",
                    model: "whisper-1",
                    source: "riffado",
                });
        }
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

    async function setOrgAudioDays(days: number | null) {
        await db()
            .update(userSettings)
            .set({ retentionLocalAudioDays: days })
            .where(eq(userSettings.userId, orgUserId));
    }

    it("keeps shared audio when the organization has no audio period", async () => {
        const org = await loadOrgRetentionContext(orgUserId);
        expect(
            await listReapCandidates(ownerAudio30, new Date(), 10, org),
        ).toEqual([]);
    });

    it("lets the longer of the two audio periods win while shared", async () => {
        await setOrgAudioDays(90);
        let org = await loadOrgRetentionContext(orgUserId);
        expect(
            await listReapCandidates(ownerAudio30, new Date(), 10, org),
        ).toEqual([]);

        await setOrgAudioDays(45);
        org = await loadOrgRetentionContext(orgUserId);
        const [candidate] = await listReapCandidates(
            ownerAudio30,
            new Date(),
            10,
            org,
        );
        expect(candidate?.audioReleasable).toBe(true);
        const storage = fakeStorage();
        const outcome = await reapRecording(
            storage,
            ownerAudio30,
            candidate as NonNullable<typeof candidate>,
        );
        expect(outcome.reaped).toEqual(["audio"]);
    });

    it("waits out the grace period after an unshare", async () => {
        await unshareRecording(OWNER, REC);
        const org = await loadOrgRetentionContext(orgUserId);
        expect(
            await listReapCandidates(ownerAudio30, new Date(), 10, org),
        ).toEqual([]);
        expect(
            await listReapCandidates(
                ownerAudio30,
                new Date(Date.now() + 8 * DAY),
                10,
                org,
            ),
        ).toHaveLength(1);
    });

    it("does not reap shared audio when the recording is due for another kind", async () => {
        const both: RetentionPolicy = { ...ownerAudio30, transcriptDays: 30 };
        const org = await loadOrgRetentionContext(orgUserId);
        const [candidate] = await listReapCandidates(both, new Date(), 10, org);
        expect(candidate?.audioReleasable).toBe(false);
        const storage = fakeStorage();
        const outcome = await reapRecording(
            storage,
            both,
            candidate as NonNullable<typeof candidate>,
        );
        expect(outcome.reaped).toEqual(["transcript"]);
        expect(storage.deleted).toEqual([]);
        const left = await db().select().from(transcriptions);
        expect(left.map((row) => row.userId)).toEqual([orgUserId]);
    });

    it("lets the organization's policy remove only the Organization view's rows", async () => {
        await db()
            .update(userSettings)
            .set({
                retentionLocalTranscriptDays: 30,
                retentionLocalAudioDays: 1,
                retentionRemoteOriginalDays: 1,
            })
            .where(eq(userSettings.userId, orgUserId));
        const [orgPolicy] = (await listArmedRetentionPolicies(10)).filter(
            (policy) => policy.isOrg,
        );
        expect(orgPolicy).toMatchObject({
            audioDays: null,
            remoteOriginalDays: null,
            transcriptDays: 30,
        });
        const [candidate] = await listReapCandidates(
            orgPolicy as RetentionPolicy,
            new Date(),
            10,
        );
        const storage = fakeStorage();
        const outcome = await reapRecording(
            storage,
            orgPolicy as RetentionPolicy,
            candidate as NonNullable<typeof candidate>,
        );
        expect(outcome.reaped).toEqual(["transcript"]);
        expect(storage.deleted).toEqual([]);
        const left = await db().select().from(transcriptions);
        expect(left.map((row) => row.userId)).toEqual([OWNER]);
        const [recording] = await db()
            .select()
            .from(recordings)
            .where(eq(recordings.id, REC));
        expect(recording?.transcriptReapedAt).toBeNull();
    });
});
