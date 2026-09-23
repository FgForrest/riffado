/**
 * Export directories after a rename, against a real PostgreSQL.
 *
 * A recording renamed after its export was planned -- by title generation,
 * a Plaud sync or a person -- must end up in one directory under its new
 * name, with nothing left under the old one. Before the export lock, a job
 * holding a path from before the rename recreated the old directory, empty
 * or with the file the new one was missing.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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

const { dbProxy, sqlProxy, dbRef, sqlRef, mockEnv, download } = vi.hoisted(
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
            /** Set to hold the next audio download until the test lets it go. */
            download: {
                hold: null as null | {
                    started: () => void;
                    released: Promise<void>;
                },
            },
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
    },
);

// The real client, not null: the export lock needs reserved connections.
vi.mock("@/db", () => ({ db: dbProxy, sqlClient: sqlProxy }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(async () => ({
        downloadStream: vi.fn(async () => {
            const hold = download.hold;
            download.hold = null;
            if (hold) {
                hold.started();
                await hold.released;
            }
            return Readable.from(Buffer.from("audio bytes!"));
        }),
    })),
}));

import { encryptText } from "@/lib/encryption/fields";
import { createFolderExport } from "@/lib/folder-exports/configurations";
import { materializeFolderExport } from "@/lib/folder-exports/execution";
import { withExportLock } from "@/lib/folder-exports/lock";
import { planFolderExport } from "@/lib/folder-exports/planner";
import { addRecordingToFolder } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const RECORDING = "rec-renamed";

/** Every directory and file under `root`, relative and sorted. */
function treeUnder(root: string): string[] {
    return readdirSync(root, { recursive: true, withFileTypes: true })
        .map((entry) => {
            const relative = path.relative(
                root,
                path.join(entry.parentPath, entry.name),
            );
            return entry.isDirectory() ? `${relative}/` : relative;
        })
        .sort();
}

describeWithDatabase("Export directories after a rename (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let exportId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    function root() {
        return mockEnv.FILESYSTEM_EXPORT_ROOT;
    }

    async function rename(title: string) {
        await db()
            .update(recordings)
            .set({ filename: encryptText(title) })
            .where(eq(recordings.id, RECORDING));
    }

    async function materializeAll() {
        const states = await db()
            .select({ id: folderExportMaterializations.id })
            .from(folderExportMaterializations)
            .where(eq(folderExportMaterializations.expected, true));
        for (const state of states) {
            await materializeFolderExport(orgUserId, state.id);
        }
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "export_stale_dirs",
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
        mockEnv.FILESYSTEM_EXPORT_ROOT = mkdtempSync(
            path.join(tmpdir(), "riffado-stale-export-"),
        );
        await db().delete(users);
        await db()
            .insert(users)
            .values([{ id: OWNER, email: "owner@example.test" }]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        const [orgRoot] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await db()
            .insert(recordings)
            .values({
                id: RECORDING,
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: `plaud-${RECORDING}`,
                filename: encryptText("Old title"),
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
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: RECORDING,
            folderId: orgRoot?.id ?? "",
        });
        const configuration = await createFolderExport(
            orgUserId,
            orgRoot?.id ?? "",
            {
                targetPath: "org",
                exportAudio: true,
                exportTranscript: true,
                exportSummary: false,
            },
        );
        exportId = configuration.id;
    });

    it("moves the directory with the rename and leaves nothing behind", async () => {
        await planFolderExport(orgUserId, exportId);
        await materializeAll();
        await rename("New title");
        await planFolderExport(orgUserId, exportId);
        await materializeAll();

        expect(treeUnder(root())).toEqual([
            "org/",
            "org/New title/",
            "org/New title/audio.mp3",
            "org/New title/riffado.transcript.md",
        ]);
    });

    it("writes a file planned before a rename into the renamed directory", async () => {
        await planFolderExport(orgUserId, exportId);
        const [audio] = await db()
            .select({ id: folderExportMaterializations.id })
            .from(folderExportMaterializations)
            .where(eq(folderExportMaterializations.artifactType, "audio"));
        await rename("New title");

        // The audio job has read its path under the old title and is
        // downloading when the plan that moves the directory starts.
        let started = () => {};
        const downloading = new Promise<void>((resolve) => {
            started = resolve;
        });
        let release = () => {};
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        download.hold = { started, released };
        const writing = materializeFolderExport(orgUserId, audio?.id ?? "");
        await downloading;
        const planning = planFolderExport(orgUserId, exportId);
        // Long enough for an unlocked plan to finish its rename first.
        await new Promise((resolve) => setTimeout(resolve, 500));
        release();
        await Promise.all([writing, planning]);
        await materializeAll();

        expect(treeUnder(root())).toEqual([
            "org/",
            "org/New title/",
            "org/New title/audio.mp3",
            "org/New title/riffado.transcript.md",
        ]);
    });

    it("plans only once a write in progress has finished", async () => {
        await planFolderExport(orgUserId, exportId);
        let finishWrite = () => {};
        const writing = withExportLock(
            exportId,
            "shared",
            () =>
                new Promise<void>((resolve) => {
                    finishWrite = resolve;
                }),
        );
        let planned = false;
        const planning = planFolderExport(orgUserId, exportId).then(() => {
            planned = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(planned).toBe(false);

        finishWrite();
        await writing;
        await planning;
        expect(planned).toBe(true);
    });

    it("removes the directory of a recording that left the export, only while empty", async () => {
        await planFolderExport(orgUserId, exportId);
        // Planned but not yet written: the directory is still empty.
        expect(treeUnder(root())).toEqual(["org/", "org/Old title/"]);
        await db()
            .update(recordings)
            .set({ deletedAt: new Date() })
            .where(eq(recordings.id, RECORDING));
        await planFolderExport(orgUserId, exportId);
        expect(treeUnder(root())).toEqual(["org/"]);
    });

    it("keeps a directory that still holds files", async () => {
        await planFolderExport(orgUserId, exportId);
        await materializeAll();
        mkdirSync(path.join(root(), "org/Old title/notes"));
        writeFileSync(path.join(root(), "org/Old title/notes/mine.md"), "x");
        await db()
            .update(recordings)
            .set({ deletedAt: new Date() })
            .where(eq(recordings.id, RECORDING));
        await planFolderExport(orgUserId, exportId);
        expect(treeUnder(root())).toEqual([
            "org/",
            "org/Old title/",
            "org/Old title/audio.mp3",
            "org/Old title/notes/",
            "org/Old title/notes/mine.md",
            "org/Old title/riffado.transcript.md",
        ]);
    });
});
