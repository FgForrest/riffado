/**
 * Filesystem exports of the Organization tree, against a real PostgreSQL.
 *
 * An Organization export is the one export whose recordings belong to other
 * people: the organization account configures it, the files it writes are
 * the Organization view of each shared recording, and the audio comes from
 * each owner's storage. These run the planner and the materializer end to
 * end into a scratch directory.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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
    folderExportMaterializations,
    recordingFolders,
    recordings,
    transcriptions,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, audioOwners } = vi.hoisted(() => {
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
        audioOwners: [] as string[],
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            FILESYSTEM_EXPORT_ROOT: "",
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(async (ownerId: string) => ({
        downloadStream: vi.fn(async () => {
            audioOwners.push(ownerId);
            return Readable.from(Buffer.from(`audio of ${ownerId}`));
        }),
    })),
}));

import { encryptText } from "@/lib/encryption/fields";
import { createFolderExport } from "@/lib/folder-exports/configurations";
import { materializeFolderExport } from "@/lib/folder-exports/execution";
import { planFolderExport } from "@/lib/folder-exports/planner";
import { addRecordingToFolder } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const MEMBER = "user-member";

function filesUnder(root: string): string[] {
    return readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
            path.relative(root, path.join(entry.parentPath, entry.name)),
        )
        .sort();
}

describeWithDatabase("Organization exports (PostgreSQL)", () => {
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
            "org_exports",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        mockEnv.FILESYSTEM_EXPORT_ROOT = mkdtempSync(
            path.join(tmpdir(), "riffado-org-export-"),
        );
        audioOwners.length = 0;
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test" },
                { id: MEMBER, email: "member@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        orgRootId = root?.id ?? "";
        for (const id of ["rec-shared", "rec-private"]) {
            await db()
                .insert(recordings)
                .values({
                    id,
                    userId: OWNER,
                    deviceSn: "SN-1",
                    plaudFileId: `plaud-${id}`,
                    filename: encryptText(`Meeting ${id}`),
                    duration: 60_000,
                    startTime: new Date("2026-09-01T10:00:00Z"),
                    endTime: new Date("2026-09-01T10:01:00Z"),
                    filesize: 18,
                    fileMd5: "0".repeat(32),
                    storageType: "local",
                    storagePath: `${OWNER}/${id}.mp3`,
                    storageFilename: `${id}.mp3`,
                    plaudVersion: "1",
                });
            await db()
                .insert(transcriptions)
                .values({
                    recordingId: id,
                    userId: OWNER,
                    text: encryptText(`words of ${id}`),
                    provider: "openai",
                    model: "whisper-1",
                    source: "riffado",
                });
        }
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: "rec-shared",
            folderId: orgRootId,
        });
    });

    const selection = {
        targetPath: "org",
        exportAudio: true,
        exportTranscript: true,
        exportSummary: false,
    };

    it("is configured only by the organization account", async () => {
        await expect(
            createFolderExport(MEMBER, orgRootId, selection),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("writes the shared recordings' Organization view, audio from the owner's storage", async () => {
        const configuration = await createFolderExport(
            orgUserId,
            orgRootId,
            selection,
        );
        await planFolderExport(orgUserId, configuration.id);
        const states = await db().select().from(folderExportMaterializations);
        expect(new Set(states.map((state) => state.recordingId))).toEqual(
            new Set(["rec-shared"]),
        );
        for (const state of states) {
            await materializeFolderExport(orgUserId, state.id);
        }

        const root = mockEnv.FILESYSTEM_EXPORT_ROOT;
        const files = filesUnder(root);
        expect(files.some((file) => file.endsWith("audio.mp3"))).toBe(true);
        const transcript = files.find((file) => file.endsWith(".md"));
        expect(transcript).toBeDefined();
        expect(
            readFileSync(path.join(root, transcript ?? ""), "utf8"),
        ).toContain("words of rec-shared");
        expect(audioOwners).toEqual([OWNER]);
    });
});
