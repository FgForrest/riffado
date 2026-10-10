/**
 * Where a filesystem export keeps a recording, against a real PostgreSQL.
 *
 * A recording lives in one directory per folder it is filed in, and only
 * there: filing, moving or renaming it moves what the export wrote rather
 * than writing it again elsewhere. The export deletes only what it created
 * and never touches anything else under the root.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
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
    asyncJobs,
    chatterItems,
    filesystemExportNodes,
    filesystemExportSettings,
    folderExportMaterializations,
    folderExportPlacements,
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

const { dbProxy, sqlProxy, dbRef, sqlRef, mockEnv, downloads } = vi.hoisted(
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
            downloads: { count: 0 },
            mockEnv: {
                IS_HOSTED: false,
                SELF_HOST_MODE: "local",
                FILESYSTEM_EXPORT_ROOT: "",
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
        downloadStream: vi.fn(async (storagePath: string) => {
            downloads.count += 1;
            return Readable.from(
                Buffer.from(
                    storagePath.endsWith("rec-beta.mp3")
                        ? "beta bytes!!"
                        : "audio bytes!",
                ),
            );
        }),
    })),
}));

import { encryptText } from "@/lib/encryption/fields";
import { createFolderExport } from "@/lib/folder-exports/configurations";
import {
    materializeFolderExport,
    reconcileFolderExport,
} from "@/lib/folder-exports/execution";
import { ExportPathTakenError } from "@/lib/folder-exports/filesystem-provider";
import {
    EXPORT_PLAN_JOB_KIND,
    enqueueExportPlan,
} from "@/lib/folder-exports/jobs";
import { planFolderExport } from "@/lib/folder-exports/planner";
import { loadExportTarget } from "@/lib/folder-exports/target";
import {
    addRecordingToFolder,
    createFolder,
    ensureRootFolders,
    moveRecordingBetweenFolders,
    removeRecordingFromFolder,
} from "@/lib/folders/folders";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const RECORDING = "rec-weekly";
const COPY = [
    "rec/Work/",
    "rec/Work/Weekly sync/",
    "rec/Work/Weekly sync/audio.mp3",
    "rec/Work/Weekly sync/riffado.transcript.md",
];

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

describeWithDatabase("Filesystem export placements (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let privateRootId = "";
    let exportId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    function root() {
        return mockEnv.FILESYSTEM_EXPORT_ROOT;
    }

    function tree() {
        return treeUnder(root());
    }

    function foreign(relative: string, content = "mine") {
        mkdirSync(path.join(root(), path.dirname(relative)), {
            recursive: true,
        });
        writeFileSync(path.join(root(), relative), content);
    }

    async function plan() {
        await planFolderExport(OWNER, exportId);
    }

    async function materializeAll() {
        const states = await db()
            .select({
                id: folderExportMaterializations.id,
                status: folderExportMaterializations.status,
            })
            .from(folderExportMaterializations)
            .where(eq(folderExportMaterializations.expected, true));
        for (const state of states) {
            if (state.status === "exported") continue;
            await materializeFolderExport(OWNER, state.id).catch(() => {});
        }
    }

    async function exportNow() {
        await plan();
        await materializeAll();
    }

    async function folder(name: string, parentId = privateRootId) {
        return (await createFolder({ userId: OWNER, parentId, name })).id;
    }

    async function file(folderId: string) {
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: RECORDING,
            folderId,
        });
    }

    async function ownedEntries() {
        const rows = await db()
            .select({
                logicalPath: filesystemExportNodes.logicalPath,
                kind: filesystemExportNodes.kind,
            })
            .from(filesystemExportNodes);
        return rows.map((row) => `${row.kind}:${row.logicalPath}`).sort();
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "export_placements",
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
            path.join(tmpdir(), "riffado-placements-"),
        );
        downloads.count = 0;
        await db().delete(asyncJobs);
        await db().delete(users);
        await db()
            .insert(users)
            .values([{ id: OWNER, email: "owner@example.test" }]);
        await ensureRootFolders(OWNER);
        const [privateRoot] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, OWNER),
                    eq(recordingFolders.kind, "private"),
                ),
            );
        privateRootId = privateRoot?.id ?? "";
        await insertRecordings(db(), {
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
        exportId = (
            await createFolderExport(OWNER, privateRootId, {
                targetPath: "rec",
                exportAudio: true,
                exportTranscript: true,
                exportSummary: false,
            })
        ).id;
    });

    it("moves a recording filed into a folder instead of writing it again", async () => {
        await exportNow();
        expect(tree()).toEqual([
            "rec/",
            "rec/Weekly sync/",
            "rec/Weekly sync/audio.mp3",
            "rec/Weekly sync/riffado.transcript.md",
        ]);

        await file(await folder("Work"));
        await exportNow();

        expect(tree()).toEqual(["rec/", ...COPY]);
        expect(downloads.count).toBe(1);
        const placements = await db()
            .select({ path: folderExportPlacements.logicalPath })
            .from(folderExportPlacements);
        expect(placements).toEqual([{ path: "rec/Work/Weekly sync" }]);
        expect(await ownedEntries()).toEqual([
            "directory:rec",
            "directory:rec/Work",
            "directory:rec/Work/Weekly sync",
            "file:rec/Work/Weekly sync/audio.mp3",
            "file:rec/Work/Weekly sync/riffado.transcript.md",
        ]);
    });

    it("follows a recording moved between folders and renamed", async () => {
        const work = await folder("Work");
        const home = await folder("Home");
        await file(work);
        await exportNow();

        await moveRecordingBetweenFolders({
            userId: OWNER,
            recordingId: RECORDING,
            fromFolderId: work,
            toFolderId: home,
        });
        await db()
            .update(chatterItems)
            .set({ title: encryptText("Weekly review") })
            .where(eq(chatterItems.id, RECORDING));
        await exportNow();

        expect(tree()).toEqual([
            "rec/",
            "rec/Home/",
            "rec/Home/Weekly review/",
            "rec/Home/Weekly review/audio.mp3",
            "rec/Home/Weekly review/riffado.transcript.md",
            "rec/Work/",
        ]);
        expect(downloads.count).toBe(1);
    });

    it("keeps one copy per folder a recording is filed in", async () => {
        const work = await folder("Work");
        const home = await folder("Home");
        await file(work);
        await file(home);
        await exportNow();
        expect(tree()).toEqual([
            "rec/",
            "rec/Home/",
            "rec/Home/Weekly sync/",
            "rec/Home/Weekly sync/audio.mp3",
            "rec/Home/Weekly sync/riffado.transcript.md",
            ...COPY,
        ]);

        await removeRecordingFromFolder({
            userId: OWNER,
            recordingId: RECORDING,
            folderId: home,
        });
        await exportNow();
        expect(tree()).toEqual(["rec/", "rec/Home/", ...COPY]);
    });

    it("writes a second copy when filed in another folder, leaving the first", async () => {
        const work = await folder("Work");
        const home = await folder("Home");
        await file(work);
        await exportNow();
        await file(home);
        await exportNow();
        expect(tree()).toEqual([
            "rec/",
            "rec/Home/",
            "rec/Home/Weekly sync/",
            "rec/Home/Weekly sync/audio.mp3",
            "rec/Home/Weekly sync/riffado.transcript.md",
            ...COPY,
        ]);
        expect(downloads.count).toBe(2);
    });

    it("never moves, reuses or deletes what it did not create", async () => {
        const work = await folder("Work");
        await exportNow();
        foreign("rec/Weekly sync/notes.txt");
        foreign("rec/Work/Weekly sync/mine.txt");
        foreign("rec/other.txt");

        await file(work);
        await exportNow();

        expect(tree()).toEqual([
            "rec/",
            "rec/Weekly sync/",
            "rec/Weekly sync/notes.txt",
            "rec/Work/",
            "rec/Work/Weekly sync (2)/",
            "rec/Work/Weekly sync (2)/audio.mp3",
            "rec/Work/Weekly sync (2)/riffado.transcript.md",
            "rec/Work/Weekly sync/",
            "rec/Work/Weekly sync/mine.txt",
            "rec/other.txt",
        ]);
        expect(downloads.count).toBe(1);
    });

    it("removes its files when the recording is deleted, keeping someone's", async () => {
        await exportNow();
        foreign("rec/Weekly sync/notes/mine.md");
        await db()
            .update(recordings)
            .set({ deletedAt: new Date() })
            .where(eq(recordings.id, RECORDING));
        await plan();
        expect(tree()).toEqual([
            "rec/",
            "rec/Weekly sync/",
            "rec/Weekly sync/notes/",
            "rec/Weekly sync/notes/mine.md",
        ]);
    });

    it("refuses to write over a file someone put in its way", async () => {
        await plan();
        foreign("rec/Weekly sync/audio.mp3");
        await materializeAll();
        expect(tree()).toContain("rec/Weekly sync/riffado.transcript.md");
        const [audio] = await db()
            .select({
                status: folderExportMaterializations.status,
                lastError: folderExportMaterializations.lastError,
            })
            .from(folderExportMaterializations)
            .where(eq(folderExportMaterializations.artifactType, "audio"));
        expect(audio?.status).toBe("failed");
        expect(audio?.lastError).toMatch(/did not create/);
        expect((await loadExportTarget(OWNER, exportId))?.lastError).toMatch(
            /did not create/,
        );
        const failure = await materializeFolderExport(
            OWNER,
            (
                await db()
                    .select({ id: folderExportMaterializations.id })
                    .from(folderExportMaterializations)
                    .where(
                        eq(folderExportMaterializations.artifactType, "audio"),
                    )
            )[0]?.id ?? "",
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ExportPathTakenError);
    });

    it("cleans up the copies an earlier version left in place", async () => {
        const work = await folder("Work");
        await exportNow();
        foreign("rec/Weekly sync/notes.txt");
        foreign("rec/other.txt");

        // What earlier versions did on filing: a second copy under the
        // folder, the first one kept, nothing recorded as owned.
        cpSync(
            path.join(root(), "rec/Weekly sync"),
            path.join(root(), "rec/Work/Weekly sync"),
            { recursive: true },
        );
        rmSync(path.join(root(), "rec/Work/Weekly sync/notes.txt"));
        await db().update(folderExportPlacements).set({ expected: false });
        await db()
            .update(folderExportMaterializations)
            .set({ expected: false });
        const [rootPlacement] = await db()
            .select()
            .from(folderExportPlacements);
        await db().insert(folderExportPlacements).values({
            userId: OWNER,
            exportConfigurationId: exportId,
            itemId: RECORDING,
            placementFolderId: work,
            targetPath: "rec",
            directoryName: "Weekly sync",
            logicalPath: "rec/Work/Weekly sync",
            expected: true,
            createdAt: rootPlacement?.createdAt,
        });
        const rootStates = await db()
            .select()
            .from(folderExportMaterializations);
        await db()
            .insert(folderExportMaterializations)
            .values(
                rootStates.map(({ id: _id, ...state }) => ({
                    ...state,
                    placementFolderId: work,
                    logicalPath: state.logicalPath.replace("rec/", "rec/Work/"),
                    expected: true,
                })),
            );
        await db().delete(filesystemExportNodes);
        await db()
            .update(filesystemExportSettings)
            .set({ nodesAdoptedAt: null });
        await file(work);

        await exportNow();
        expect(tree()).toEqual([
            "rec/",
            "rec/Weekly sync/",
            "rec/Weekly sync/notes.txt",
            ...COPY,
            "rec/other.txt",
        ]);
        expect(downloads.count).toBe(1);
        const states = await db()
            .select({ path: folderExportMaterializations.logicalPath })
            .from(folderExportMaterializations);
        expect(states.map((state) => state.path).sort()).toEqual([
            "rec/Work/Weekly sync/audio.mp3",
            "rec/Work/Weekly sync/riffado.transcript.md",
        ]);
    });

    it("keeps audio retention reaped, and moves it with the recording", async () => {
        await exportNow();
        await db()
            .update(recordings)
            .set({ audioReapedAt: new Date() })
            .where(eq(recordings.id, RECORDING));
        await file(await folder("Work"));
        await exportNow();
        expect(tree()).toEqual(["rec/", ...COPY]);
        expect(downloads.count).toBe(1);

        // Gone from the export too: nothing is left to write it from.
        rmSync(path.join(root(), "rec/Work/Weekly sync/audio.mp3"));
        await reconcileFolderExport(OWNER, privateRootId);
        await materializeAll();
        await exportNow();
        expect(tree()).toEqual([
            "rec/",
            "rec/Work/",
            "rec/Work/Weekly sync/",
            "rec/Work/Weekly sync/riffado.transcript.md",
        ]);
        expect(downloads.count).toBe(1);
    });

    it("writes again what someone removed when the folder is synchronized", async () => {
        await exportNow();
        rmSync(path.join(root(), "rec/Weekly sync/audio.mp3"));
        await expect(
            reconcileFolderExport(OWNER, privateRootId),
        ).resolves.toEqual({ checked: 2, pending: 1 });
        await materializeAll();
        expect(tree()).toContain("rec/Weekly sync/audio.mp3");

        rmSync(path.join(root(), "rec/Weekly sync"), { recursive: true });
        await reconcileFolderExport(OWNER, privateRootId);
        await materializeAll();
        expect(tree()).toEqual([
            "rec/",
            "rec/Weekly sync/",
            "rec/Weekly sync/audio.mp3",
            "rec/Weekly sync/riffado.transcript.md",
        ]);
        expect(downloads.count).toBe(3);
    });

    it("never gives a recording the directory another one is leaving", async () => {
        await insertRecordings(db(), {
            id: "rec-beta",
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: "plaud-rec-beta",
            filename: encryptText("Beta"),
            duration: 60_000,
            startTime: new Date("2026-09-02T10:00:00Z"),
            endTime: new Date("2026-09-02T10:01:00Z"),
            filesize: 12,
            fileMd5: "1".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/rec-beta.mp3`,
            storageFilename: "rec-beta.mp3",
            plaudVersion: "1",
        });
        await exportNow();
        // Beta's audio now lives only in the export.
        await db()
            .update(recordings)
            .set({ audioReapedAt: new Date() })
            .where(eq(recordings.id, "rec-beta"));
        await db()
            .update(recordings)
            .set({ deletedAt: new Date() })
            .where(eq(recordings.id, RECORDING));
        await db()
            .update(chatterItems)
            .set({ title: encryptText("Weekly sync") })
            .where(eq(chatterItems.id, "rec-beta"));

        await exportNow();
        expect(tree()).toEqual([
            "rec/",
            "rec/Weekly sync (2)/",
            "rec/Weekly sync (2)/audio.mp3",
        ]);
        await exportNow();
        expect(tree()).toEqual([
            "rec/",
            "rec/Weekly sync/",
            "rec/Weekly sync/audio.mp3",
        ]);
        expect(
            readFileSync(
                path.join(root(), "rec/Weekly sync/audio.mp3"),
                "utf8",
            ),
        ).toBe("beta bytes!!");
        expect(downloads.count).toBe(2);
    });

    it("does not adopt what another of the user's exports already owns", async () => {
        await exportNow();
        const other = await createFolderExport(OWNER, await folder("Work"), {
            targetPath: "rec2",
            exportAudio: true,
            exportTranscript: false,
            exportSummary: false,
        });
        await db().delete(filesystemExportNodes);
        await db()
            .update(filesystemExportSettings)
            .set({ nodesAdoptedAt: null });
        await db().insert(filesystemExportNodes).values({
            userId: OWNER,
            exportConfigurationId: other.id,
            logicalPath: "rec/Weekly sync/audio.mp3",
            kind: "file",
        });
        await plan();
        const own = await db()
            .select({ logicalPath: filesystemExportNodes.logicalPath })
            .from(filesystemExportNodes)
            .where(eq(filesystemExportNodes.exportConfigurationId, exportId));
        expect(own.map((row) => row.logicalPath).sort()).toEqual([
            "rec/Weekly sync",
            "rec/Weekly sync/riffado.transcript.md",
            "rec/Work",
        ]);
    });

    it("queues one more plan behind a running one", async () => {
        await db()
            .update(asyncJobs)
            .set({ status: "processing" })
            .where(eq(asyncJobs.kind, EXPORT_PLAN_JOB_KIND));
        const again = await enqueueExportPlan(OWNER, exportId);
        expect(again.created).toBe(true);
        expect(again.job.subjectId).toBe(`${exportId}:again`);
        expect(again.job.payload).toEqual({ exportId });
        const folded = await enqueueExportPlan(OWNER, exportId);
        expect(folded.created).toBe(false);
        expect(folded.job.id).toBe(again.job.id);
    });
});
