/**
 * Folder export into Google Drive, end to end against a real PostgreSQL:
 * the planner, the executor and the node store, writing through the same
 * code as production into an in-memory Drive.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

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
    aiEnhancements,
    driveExportNodes,
    folderExportMaterializations,
    googleDriveExportSettings,
    recordings,
    transcriptions,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, sqlProxy, dbRef, sqlRef, mockEnv, driveRef } = vi.hoisted(
    () => {
        function lazy(ref: { current: Record<PropertyKey, unknown> | null }) {
            return new Proxy(
                {},
                {
                    get: (_target, property: string | symbol) => {
                        const current = ref.current;
                        if (!current) {
                            throw new Error(
                                "test database was not initialized",
                            );
                        }
                        const value = current[property];
                        return typeof value === "function"
                            ? value.bind(current)
                            : value;
                    },
                },
            );
        }
        const dbRef: { current: Record<PropertyKey, unknown> | null } = {
            current: null,
        };
        const sqlRef: { current: Record<PropertyKey, unknown> | null } = {
            current: null,
        };
        return {
            dbProxy: lazy(dbRef),
            sqlProxy: lazy(sqlRef),
            dbRef,
            sqlRef,
            driveRef: { current: null as unknown },
            mockEnv: {
                IS_HOSTED: false,
                SELF_HOST_MODE: "shared",
                FILESYSTEM_EXPORT_ROOT: "",
                APP_URL: "https://riffado.example",
                GOOGLE_CLIENT_ID: "client",
                GOOGLE_CLIENT_SECRET: "secret",
                GOOGLE_PICKER_API_KEY: "picker",
                GOOGLE_CLOUD_PROJECT_NUMBER: "1234",
                GOOGLE_WORKSPACE_DOMAINS: [] as string[],
                ENCRYPTION_KEY:
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
                DATABASE_URL: "postgres://unused",
            },
        };
    },
);

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: sqlProxy }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(async () => ({
        downloadStream: vi.fn(async () =>
            Readable.from(Buffer.from("audio bytes!")),
        ),
    })),
}));
vi.mock("@/lib/integrations/google/drive-client", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("@/lib/integrations/google/drive-client")
    >()),
    createDriveClient: () => driveRef.current,
}));

import { encryptText } from "@/lib/encryption/fields";
import {
    createFolderExport,
    updateFolderExport,
} from "@/lib/folder-exports/configurations";
import { DriveTargetLostError } from "@/lib/folder-exports/drive-provider";
import {
    materializeFolderExport,
    reconcileFolderExport,
} from "@/lib/folder-exports/execution";
import { planFolderExport } from "@/lib/folder-exports/planner";
import { isExportErrorRetryable } from "@/lib/folder-exports/retry";
import { loadExportTarget } from "@/lib/folder-exports/target";
import {
    addRecordingToFolder,
    createFolder,
    ensureRootFolders,
    listFolderOrganization,
} from "@/lib/folders/folders";
import {
    __resetGoogleAccessTokensForTests,
    markGoogleNeedsReconnect,
    saveGoogleConnection,
} from "@/lib/integrations/google/connection";
import { GoogleConnectionUnavailableError } from "@/lib/integrations/google/errors";
import { FakeDrive } from "@/tests/integrations/google/fake-drive";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-drive-owner";
const RECORDING = "rec-drive";
const ROOT = "pickedfolder1";
const SCOPES = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/drive.file",
];

describeWithDatabase("Google Drive folder export (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let drive: FakeDrive;
    let teamFolderId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function connect(subject = "sub-1") {
        await saveGoogleConnection(
            OWNER,
            {
                subject,
                email: `${subject}@example.com`,
                emailVerified: true,
                hostedDomain: "example.com",
            },
            {
                accessToken: `access-${subject}`,
                expiresInSeconds: 3600,
                refreshToken: `refresh-${subject}`,
                scopes: SCOPES,
                idToken: null,
            },
        );
    }

    async function states() {
        return db()
            .select({
                id: folderExportMaterializations.id,
                logicalPath: folderExportMaterializations.logicalPath,
                format: folderExportMaterializations.format,
                status: folderExportMaterializations.status,
                expected: folderExportMaterializations.expected,
                lastError: folderExportMaterializations.lastError,
            })
            .from(folderExportMaterializations);
    }

    async function materializeAll() {
        for (const state of await states()) {
            if (state.expected) {
                await materializeFolderExport(OWNER, state.id);
            }
        }
    }

    async function createExport(
        summaryFormat: "markdown" | "google_doc" | "both" = "both",
    ) {
        return createFolderExport(OWNER, teamFolderId, {
            provider: "google-drive",
            rootFolderId: ROOT,
            exportAudio: true,
            exportTranscript: true,
            exportSummary: true,
            transcriptFormat: "google_doc",
            summaryFormat,
        });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "drive_export",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        sqlRef.current = database.sql as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        sqlRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        drive = new FakeDrive();
        drive.addRoot(ROOT, "Company exports");
        driveRef.current = drive;
        __resetGoogleAccessTokensForTests();
        await db().delete(users);
        await db()
            .insert(users)
            .values([{ id: OWNER, email: "owner@example.com" }]);
        await ensureRootFolders(OWNER);
        const organization = await listFolderOrganization(OWNER);
        const privateRoot = organization.folders.find(
            (folder) => folder.kind === "private",
        );
        const team = await createFolder({
            userId: OWNER,
            parentId: privateRoot?.id ?? "",
            name: "Team",
        });
        teamFolderId = team.id;
        await db()
            .insert(recordings)
            .values({
                id: RECORDING,
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: `plaud-${RECORDING}`,
                filename: encryptText("Weekly sync"),
                duration: 60_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:01:00Z"),
                filesize: 12,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${OWNER}/${RECORDING}.mp3`,
                storageFilename: `${RECORDING}.mp3`,
                plaudVersion: "1",
            });
        await db()
            .insert(transcriptions)
            .values({
                recordingId: RECORDING,
                userId: OWNER,
                text: encryptText("words"),
                provider: "openai",
                model: "whisper-1",
                source: "riffado",
            });
        await db()
            .insert(aiEnhancements)
            .values({
                recordingId: RECORDING,
                userId: OWNER,
                summary: encryptText("A short summary."),
                provider: "openai",
                model: "gpt",
                source: "riffado",
            });
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: RECORDING,
            folderId: teamFolderId,
        });
        await connect();
    });

    it("writes audio, Docs and Markdown into the picked folder", async () => {
        const configuration = await createExport();
        expect(configuration.googleDrive).toMatchObject({
            rootFolderId: ROOT,
            rootFolderName: "Company exports",
            transcriptFormat: "google_doc",
            summaryFormat: "both",
        });
        await planFolderExport(OWNER, configuration.id);
        await materializeAll();

        expect(drive.tree(ROOT)).toEqual([
            "Weekly sync/",
            "Weekly sync/audio.mp3",
            "Weekly sync/riffado.summary [doc]",
            "Weekly sync/riffado.summary.md",
            "Weekly sync/riffado.transcript [doc]",
        ]);
        expect(drive.contentAt(ROOT, "Weekly sync/audio.mp3")).toBe(
            "audio bytes!",
        );
        expect(
            (await states()).map((state) => [state.format, state.status]),
        ).toEqual(
            expect.arrayContaining([
                ["file", "exported"],
                ["google_doc", "exported"],
            ]),
        );
        expect(
            (await states()).every((state) => state.status === "exported"),
        ).toBe(true);
    });

    it("renames the recording's folder in place on a rename", async () => {
        const configuration = await createExport("markdown");
        await planFolderExport(OWNER, configuration.id);
        await materializeAll();
        const folderId = drive.idAt(ROOT, "Weekly sync");
        const audioId = drive.idAt(ROOT, "Weekly sync/audio.mp3");
        drive.calls.length = 0;
        await db()
            .update(recordings)
            .set({ filename: encryptText("Weekly review") })
            .where(eq(recordings.id, RECORDING));
        await planFolderExport(OWNER, configuration.id);
        await materializeAll();

        expect(drive.tree(ROOT)).toEqual([
            "Weekly review/",
            "Weekly review/audio.mp3",
            "Weekly review/riffado.summary.md",
            "Weekly review/riffado.transcript [doc]",
        ]);
        expect(drive.idAt(ROOT, "Weekly review")).toBe(folderId);
        expect(drive.idAt(ROOT, "Weekly review/audio.mp3")).toBe(audioId);
        // The documents carry the title, so they are rewritten; the audio
        // moved with its folder and is not uploaded again.
        expect(drive.calls.filter((call) => call === "upload")).toHaveLength(2);
    });

    it("trashes the folder of a recording that left before anything was written", async () => {
        const configuration = await createExport();
        await planFolderExport(OWNER, configuration.id);
        const folderId = drive.idAt(ROOT, "Weekly sync") ?? "";
        await db()
            .update(recordings)
            .set({ deletedAt: new Date() })
            .where(eq(recordings.id, RECORDING));
        await planFolderExport(OWNER, configuration.id);

        expect(drive.tree(ROOT)).toEqual([]);
        expect(drive.isTrashed(folderId)).toBe(true);
    });

    it("keeps the folder of a recording that left once files are in it", async () => {
        const configuration = await createExport();
        await planFolderExport(OWNER, configuration.id);
        await materializeAll();
        await db()
            .update(recordings)
            .set({ deletedAt: new Date() })
            .where(eq(recordings.id, RECORDING));
        await planFolderExport(OWNER, configuration.id);

        expect(drive.tree(ROOT)).toContain("Weekly sync/audio.mp3");
    });

    it("waits for a reconnect when the account was revoked", async () => {
        const configuration = await createExport();
        await planFolderExport(OWNER, configuration.id);
        await markGoogleNeedsReconnect(OWNER, "Token has been revoked");
        const [state] = await states();
        const failure = await materializeFolderExport(
            OWNER,
            state?.id ?? "",
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GoogleConnectionUnavailableError);
        expect(isExportErrorRetryable(failure)).toBe(false);
        expect(
            (await states()).find((row) => row.id === state?.id)?.status,
        ).toBe("failed");
        expect(
            (await loadExportTarget(OWNER, configuration.id))?.lastError,
        ).toBe("The Google account must be reconnected");

        await connect();
        await planFolderExport(OWNER, configuration.id);
        await materializeAll();
        expect((await states()).every((row) => row.status === "exported")).toBe(
            true,
        );
    });

    it("writes only through the account that picked the folder", async () => {
        const configuration = await createExport();
        await connect("sub-2");
        const failure = await planFolderExport(OWNER, configuration.id).catch(
            (error: unknown) => error,
        );
        expect(failure).toMatchObject({ problem: "account_mismatch" });
        await updateFolderExport(OWNER, teamFolderId, configuration.id, {
            provider: "google-drive",
            rootFolderId: ROOT,
            exportAudio: true,
            exportTranscript: false,
            exportSummary: false,
            transcriptFormat: "markdown",
            summaryFormat: "markdown",
        });
        const [settings] = await db()
            .select({ subject: googleDriveExportSettings.accountSubject })
            .from(googleDriveExportSettings);
        expect(settings?.subject).toBe("sub-2");
        await planFolderExport(OWNER, configuration.id);
        await materializeAll();
        expect(drive.tree(ROOT)).toEqual([
            "Weekly sync/",
            "Weekly sync/audio.mp3",
        ]);
    });

    it("stops before changing anything when the picked folder is gone", async () => {
        const configuration = await createExport();
        await planFolderExport(OWNER, configuration.id);
        const before = await states();
        await drive.updateItem(ROOT, { trashed: true });
        const failure = await planFolderExport(OWNER, configuration.id).catch(
            (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(DriveTargetLostError);
        expect(isExportErrorRetryable(failure)).toBe(false);
        expect(await states()).toEqual(before);
        expect(
            (await loadExportTarget(OWNER, configuration.id))?.lastError,
        ).toMatch(/no longer exists or is in the trash/);

        await drive.updateItem(ROOT, { trashed: false });
        await planFolderExport(OWNER, configuration.id);
        expect(
            (await loadExportTarget(OWNER, configuration.id))?.lastError,
        ).toBeNull();
    });

    it("restores a Doc someone deleted when the folder is synchronized", async () => {
        const configuration = await createExport("google_doc");
        await planFolderExport(OWNER, configuration.id);
        await materializeAll();
        const docId = drive.idAt(ROOT, "Weekly sync/riffado.summary") ?? "";
        drive.items.delete(docId);

        const result = await reconcileFolderExport(OWNER, teamFolderId);
        expect(result).toEqual({ checked: 3, pending: 1 });
        await materializeAll();
        expect(drive.tree(ROOT)).toContain("Weekly sync/riffado.summary [doc]");
        expect(drive.idAt(ROOT, "Weekly sync/riffado.summary")).not.toBe(docId);
    });

    it("refuses a target that is not a writable folder", async () => {
        drive.addRoot("readonly1", "Read only", false);
        await drive.upload({
            parentId: ROOT,
            name: "file.txt",
            content: Buffer.from("x"),
            contentType: "text/plain",
            appProperties: {},
        });
        const fileId = drive.idAt(ROOT, "file.txt") ?? "";
        for (const [rootFolderId, message] of [
            ["readonly1", /cannot add files/],
            [fileId, /not available/],
            ["missing1", /not available/],
            ["../bad", /Choose a Google Drive folder/],
        ] as const) {
            await expect(
                createFolderExport(OWNER, teamFolderId, {
                    provider: "google-drive",
                    rootFolderId,
                    exportAudio: true,
                    exportTranscript: false,
                    exportSummary: false,
                    transcriptFormat: "markdown",
                    summaryFormat: "markdown",
                }),
            ).rejects.toThrow(message);
        }
    });

    it("keeps its node map in step with Drive", async () => {
        const configuration = await createExport("markdown");
        await planFolderExport(OWNER, configuration.id);
        await materializeAll();
        const nodes = await db()
            .select({
                logicalPath: driveExportNodes.logicalPath,
                kind: driveExportNodes.kind,
            })
            .from(driveExportNodes);
        expect(
            nodes.map((node) => `${node.kind}:${node.logicalPath}`).sort(),
        ).toEqual([
            `file:${ROOT}/Weekly sync/audio.mp3`,
            `file:${ROOT}/Weekly sync/riffado.summary.md`,
            `folder:${ROOT}/Weekly sync`,
            `google_doc:${ROOT}/Weekly sync/riffado.transcript`,
        ]);
    });
});
