/**
 * Backup and export scope against a real PostgreSQL: a person's archive
 * carries their own content and nothing a colleague or the Organization
 * wrote, the organization account's carries the Organization's (shared)
 * content and nobody's private one, and neither can fetch the other's.
 *
 * Every string only another account holds is a `BRAVO` sentinel, so a leak
 * shows up as a plain substring of the archive.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import type { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import unzipper from "unzipper";
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
    exportJobs,
    people,
    personNotes,
    recordingFolders,
    recordingTasks,
    taskUpdateProposals,
    transcriptions,
    transcriptSpeakerRejections,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, sessionUser } = vi.hoisted(() => {
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
        sessionUser: { id: "" },
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: sessionUser.id } })),
}));

import { GET as downloadBackup } from "@/app/api/backup/[jobId]/download/route";
import { GET as exportFile } from "@/app/api/export/route";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import type { ArchiveScope } from "@/lib/export/archive-scope";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import {
    folderExportDocumentOptions,
    getRecordingMarkdownDocument,
} from "@/lib/export/document-sidecars";
import { resolveArchiveScope } from "@/lib/export/resolve-archive-scope";
import { addRecordingToFolder } from "@/lib/folders/folders";
import { acceptCorrection } from "@/lib/knowledge/corrections";
import { confirmedOverlays } from "@/lib/learn/llm-input";
import { ensureOrgAccount } from "@/lib/org/account";
import type { StorageProvider } from "@/lib/storage/types";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BRAVO = "user-bravo";
const SHARED = "rec-alice-shared";
const PRIVATE_ALICE = "rec-alice-private";
const PRIVATE_BRAVO = "rec-bravo-private";

const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 12_000,
        text: "Tady Novák, vedu Orion a zítra volám Honzovi.",
    },
];
const at = (heard: string) => {
    const charStart = TURNS[0]?.text.indexOf(heard) ?? -1;
    return {
        turnIndex: 0,
        charStart,
        charEnd: charStart + heard.length,
        heard,
    };
};

describeWithDatabase("backup and export scope (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let sharedTranscript = "";
    let jan = "";
    let colleague = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "archive_scope",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    async function recording(id: string, userId: string, title: string) {
        await insertRecordings(db(), {
            id,
            userId,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText(title),
            duration: 12_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:12Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${userId}/${id}.mp3`,
            plaudVersion: "1",
        });
    }

    async function transcript(
        recordingId: string,
        userId: string,
        text: string,
    ) {
        const [row] = await db()
            .insert(transcriptions)
            .values({
                recordingId,
                userId,
                text: encryptText(text),
                turns: encryptJsonField([{ ...TURNS[0], text }]),
                detectedLanguage: "cs",
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        return row?.id ?? "";
    }

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test", name: "Alice" },
                {
                    id: BRAVO,
                    email: "bravo-account@example.test",
                    name: "BRAVO-ACCOUNT-NAME",
                },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";

        await recording(SHARED, ALICE, "Weekly");
        sharedTranscript = await transcript(
            SHARED,
            ALICE,
            TURNS[0]?.text ?? "",
        );
        await recording(PRIVATE_ALICE, ALICE, "Alice diary");
        await transcript(PRIVATE_ALICE, ALICE, "Alice private words.");
        await recording(PRIVATE_BRAVO, BRAVO, "BRAVO-PRIVATE-TITLE");
        await transcript(PRIVATE_BRAVO, BRAVO, "BRAVO-PRIVATE-TEXT");

        // Alice names her speaker; sharing promotes Jan to the Organization.
        const [person] = await db()
            .insert(people)
            .values({
                userId: ALICE,
                displayName: encryptText("Jan Novotný"),
                primaryEmail: encryptText("jan@example.test"),
            })
            .returning({ id: people.id });
        jan = person?.id ?? "";
        await db().insert(transcriptSpeakers).values({
            userId: ALICE,
            transcriptionId: sharedTranscript,
            label: "speaker_0",
            personId: jan,
            source: "user",
            status: "confirmed",
            confirmedByUserId: ALICE,
        });
        await acceptCorrection({
            userId: ALICE,
            transcriptionId: sharedTranscript,
            revision: 0,
            anchor: at("Novák"),
            kind: "correct",
            target: { personId: jan },
            replacement: "Novotný",
            actorUserId: ALICE,
            orgUserId,
        });
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: ALICE,
            recordingId: SHARED,
            folderId: root?.id ?? "",
        });

        // A colleague's Organization person, and the Organization's own
        // correction naming them on Alice's shared transcript.
        const [other] = await db()
            .insert(people)
            .values({
                userId: orgUserId,
                displayName: encryptText("Honza Dvořák"),
                primaryEmail: encryptText("bravo-person@example.test"),
                notes: encryptText("BRAVO-ORG-NOTES"),
                createdByUserId: BRAVO,
            })
            .returning({ id: people.id });
        colleague = other?.id ?? "";
        await acceptCorrection({
            userId: ALICE,
            transcriptionId: sharedTranscript,
            revision: 0,
            anchor: at("Honzovi"),
            kind: "correct",
            target: { personId: colleague },
            replacement: "BRAVO-CORRECTION",
            actorUserId: orgUserId,
            orgUserId,
        });
        // Alice once said her speaker is not the colleague's person, and
        // a colleague re-confirmed her speaker and wrote notes on Jan.
        await db().insert(transcriptSpeakerRejections).values({
            userId: ALICE,
            transcriptionId: sharedTranscript,
            label: "speaker_0",
            personId: colleague,
        });
        await db()
            .update(transcriptSpeakers)
            .set({ confirmedByUserId: BRAVO })
            .where(eq(transcriptSpeakers.transcriptionId, sharedTranscript));
        await db()
            .insert(personNotes)
            .values({
                personId: jan,
                userId: BRAVO,
                notes: encryptText("BRAVO-OVERLAY-NOTES"),
            });
    });

    async function archive(scope: ArchiveScope) {
        const storage = new ArchiveStorage();
        await buildAndUploadExportArchive({
            scope,
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/archive.zip",
        });
        const directory = await unzipper.Open.buffer(storage.uploaded);
        const files = new Map<string, string>();
        for (const entry of directory.files) {
            files.set(entry.path, (await entry.buffer()).toString("utf-8"));
        }
        const json = (path: string) => JSON.parse(files.get(path) ?? "{}");
        return { text: [...files.values()].join("\n"), json };
    }

    it("resolves the scope from the account", async () => {
        expect(await resolveArchiveScope(ALICE)).toEqual({
            kind: "personal",
            userId: ALICE,
        });
        expect(await resolveArchiveScope(orgUserId)).toEqual({
            kind: "organization",
            orgUserId,
        });
        mockEnv.SELF_HOST_MODE = "local";
        try {
            await expect(resolveArchiveScope(orgUserId)).rejects.toMatchObject({
                statusCode: 409,
            });
        } finally {
            mockEnv.SELF_HOST_MODE = "shared";
        }
    });

    it("gives a person their own recordings and nothing a colleague or the Organization wrote", async () => {
        const { text, json } = await archive({
            kind: "personal",
            userId: ALICE,
        });
        expect(json("manifest.json").scope).toBe("personal");
        expect(
            json("manifest.json").recordings.map(
                (row: { id: string }) => row.id,
            ),
        ).toEqual(expect.arrayContaining([SHARED, PRIVATE_ALICE]));
        expect(json("manifest.json").recordings).toHaveLength(2);
        expect(text).not.toContain("BRAVO");
        expect(text).not.toContain(BRAVO);
        expect(text).not.toContain(PRIVATE_BRAVO);

        const knowledge = json("knowledge/people.json");
        // Her own correction, published by the share, is still hers.
        expect(
            knowledge.corrections.map((row: { heard: string }) => row.heard),
        ).toEqual(["Novák"]);
        // Jan she created: in full. The colleague's person: a name.
        expect(knowledge.people).toContainEqual(
            expect.objectContaining({
                id: jan,
                organization: true,
                primaryEmail: "jan@example.test",
                notes: null,
            }),
        );
        expect(knowledge.people).toContainEqual(
            expect.objectContaining({
                id: colleague,
                displayName: "Honza Dvořák",
                organization: true,
                primaryEmail: null,
                notes: null,
            }),
        );
        expect(knowledge.attributions).toEqual([
            expect.objectContaining({ personId: jan, confirmedByUserId: null }),
        ]);
    });

    it("gives the colleague none of Alice's recordings", async () => {
        const { text, json } = await archive({
            kind: "personal",
            userId: BRAVO,
        });
        expect(
            json("manifest.json").recordings.map(
                (row: { id: string }) => row.id,
            ),
        ).toEqual([PRIVATE_BRAVO]);
        expect(text).not.toContain(SHARED);
        expect(text).not.toContain("Novák");
        expect(text).not.toContain("Alice");
    });

    it("gives the Organization every shared recording with its owner, and nobody's private content", async () => {
        const { text, json } = await archive({
            kind: "organization",
            orgUserId,
        });
        const manifest = json("manifest.json");
        expect(manifest.scope).toBe("organization");
        expect(manifest.recordings).toEqual([
            expect.objectContaining({
                id: SHARED,
                owner: {
                    id: ALICE,
                    name: "Alice",
                    email: "alice@example.test",
                },
            }),
        ]);
        expect(text).not.toContain(PRIVATE_ALICE);
        expect(text).not.toContain("Alice private words.");
        expect(text).not.toContain("BRAVO-PRIVATE");
        expect(text).not.toContain("BRAVO-OVERLAY-NOTES");

        const knowledge = json("knowledge/people.json");
        expect(
            knowledge.corrections.map((row: { heard: string }) => row.heard),
        ).toEqual(expect.arrayContaining(["Novák", "Honzovi"]));
        expect(knowledge.people).toContainEqual(
            expect.objectContaining({
                id: colleague,
                createdByUserId: BRAVO,
                notes: "BRAVO-ORG-NOTES",
            }),
        );
        // The owners' speaker rows on the shared transcript come along.
        expect(knowledge.attributions).toContainEqual(
            expect.objectContaining({
                transcriptionId: sharedTranscript,
                personId: jan,
            }),
        );
        const folders = json("organization/folders.json");
        expect(folders.assignments).toContainEqual(
            expect.objectContaining({ recordingId: SHARED }),
        );
    });

    it("carries tasks, proposals and follow-ups by the same rules, and none to an assignee", async () => {
        // A colleague's Organization person, named only by a task.
        const [petra] = await db()
            .insert(people)
            .values({
                userId: orgUserId,
                displayName: encryptText("Petra Malá"),
                primaryEmail: encryptText("BRAVO-PETRA@example.test"),
                createdByUserId: BRAVO,
            })
            .returning({ id: people.id });
        const [call] = await db()
            .insert(recordingTasks)
            .values({
                itemId: SHARED,
                userId: ALICE,
                status: "open",
                text: encryptText("Call Petra"),
                assigneePersonId: petra?.id,
                source: "riffado",
                createdByUserId: ALICE,
            })
            .returning({ id: recordingTasks.id });
        await db()
            .insert(recordingTasks)
            .values([
                {
                    itemId: SHARED,
                    userId: ALICE,
                    status: "proposed",
                    text: encryptText("Book the venue"),
                    source: "riffado",
                    ticked: true,
                },
                {
                    itemId: SHARED,
                    userId: ALICE,
                    status: "open",
                    text: encryptText("BRAVO-ORG-TASK"),
                    source: "manual",
                    createdByUserId: orgUserId,
                },
                {
                    itemId: PRIVATE_BRAVO,
                    userId: BRAVO,
                    status: "open",
                    text: encryptText("BRAVO-PRIVATE-TASK"),
                    source: "manual",
                    createdByUserId: BRAVO,
                },
            ]);
        await db()
            .insert(taskUpdateProposals)
            .values({
                taskId: call?.id ?? "",
                itemId: PRIVATE_ALICE,
                userId: ALICE,
                kind: "done",
                quote: encryptText("I called Petra"),
            });
        type Archive = Awaited<ReturnType<typeof archive>>;
        const listed = (from: Archive, recordingId: string, file: string) => {
            const entry = from
                .json("manifest.json")
                .recordings.find(
                    (row: { id: string }) => row.id === recordingId,
                );
            const path = entry?.[file]?.path;
            return path ? from.json(path) : [];
        };
        const texts = (from: Archive, recordingId: string) =>
            listed(from, recordingId, "tasks")
                .map((task: { text: string }) => task.text)
                .sort();

        const alice = await archive({ kind: "personal", userId: ALICE });
        expect(texts(alice, SHARED)).toEqual(["Book the venue", "Call Petra"]);
        expect(listed(alice, SHARED, "tasks")).toContainEqual(
            expect.objectContaining({
                status: "proposed",
                review: { ticked: true, assigneeCheck: false },
            }),
        );
        expect(listed(alice, PRIVATE_ALICE, "taskUpdates")).toEqual([
            expect.objectContaining({
                taskId: call?.id,
                kind: "done",
                quote: "I called Petra",
            }),
        ]);
        // The assignee goes by name, as a colleague's person does.
        expect(alice.json("knowledge/people.json").people).toContainEqual(
            expect.objectContaining({
                id: petra?.id,
                displayName: "Petra Malá",
                organization: true,
                primaryEmail: null,
            }),
        );
        expect(alice.text).not.toContain("BRAVO");

        // The colleague: their own task, none of Alice's, whoever they name.
        const bravo = await archive({ kind: "personal", userId: BRAVO });
        expect(texts(bravo, PRIVATE_BRAVO)).toEqual(["BRAVO-PRIVATE-TASK"]);
        for (const words of ["Call Petra", "Book the venue", "I called"]) {
            expect(bravo.text).not.toContain(words);
        }

        // The Organization: every task of the shared recording, nothing private.
        const organization = await archive({ kind: "organization", orgUserId });
        expect(texts(organization, SHARED)).toEqual([
            "BRAVO-ORG-TASK",
            "Book the venue",
            "Call Petra",
        ]);
        expect(organization.text).not.toContain("BRAVO-PRIVATE-TASK");
        expect(organization.text).not.toContain("I called Petra");
    });

    it("renders a person's exports without the Organization's corrections", async () => {
        const overlays = await confirmedOverlays({
            ownerUserId: ALICE,
            ownerAuthoredOnly: true,
        });
        expect(overlays.get(sharedTranscript)?.map((row) => row.heard)).toEqual(
            ["Novák"],
        );

        const personal = await getRecordingMarkdownDocument(
            ALICE,
            SHARED,
            "transcript",
            folderExportDocumentOptions("riffado", false),
        );
        expect(personal?.content).toContain("Novotný");
        expect(personal?.content).not.toContain("BRAVO-CORRECTION");
        const organization = await getRecordingMarkdownDocument(
            ALICE,
            SHARED,
            "transcript",
            folderExportDocumentOptions("riffado", true),
        );
        expect(organization?.content).toContain("BRAVO-CORRECTION");

        sessionUser.id = ALICE;
        const own = await (
            await exportFile(
                new Request("https://app.example.test/api/export?format=json"),
            )
        ).text();
        expect(own).toContain(PRIVATE_ALICE);
        expect(own).not.toContain("BRAVO");

        sessionUser.id = orgUserId;
        const shared = await (
            await exportFile(
                new Request("https://app.example.test/api/export?format=json"),
            )
        ).text();
        expect(shared).toContain(SHARED);
        expect(shared).toContain("BRAVO-CORRECTION");
        expect(shared).not.toContain(PRIVATE_ALICE);
        expect(shared).not.toContain(PRIVATE_BRAVO);
    });

    it("lets only the account that made an archive download it", async () => {
        const completed = (userId: string) =>
            db()
                .insert(exportJobs)
                .values({
                    userId,
                    status: "completed",
                    storageKey: `exports/${userId}/job.zip`,
                    completedAt: new Date(),
                })
                .returning({ id: exportJobs.id })
                .then((rows) => rows[0]?.id ?? "");
        const orgJob = await completed(orgUserId);
        const aliceJob = await completed(ALICE);
        const download = (jobId: string) =>
            downloadBackup(
                new Request(
                    `https://app.example.test/api/backup/${jobId}/download`,
                ),
                { params: Promise.resolve({ jobId }) },
            );

        sessionUser.id = ALICE;
        expect((await download(orgJob)).status).toBe(404);
        sessionUser.id = BRAVO;
        expect((await download(aliceJob)).status).toBe(404);
        expect((await download(orgJob)).status).toBe(404);
        sessionUser.id = orgUserId;
        expect((await download(aliceJob)).status).toBe(404);
    });
});

/** Captures the archive; no recording's audio is there. */
class ArchiveStorage implements StorageProvider {
    uploaded = Buffer.alloc(0);
    async uploadFile(key: string): Promise<string> {
        return key;
    }
    async downloadFile(): Promise<Buffer> {
        throw new Error("not found");
    }
    async downloadStream(): Promise<Readable> {
        throw new Error("not found");
    }
    async uploadStream(key: string, stream: Readable): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        this.uploaded = Buffer.concat(chunks);
        return key;
    }
    async exists(): Promise<boolean> {
        return false;
    }
    async getSignedUrl(): Promise<string> {
        return "";
    }
    async deleteFile(): Promise<void> {}
    async testConnection(): Promise<boolean> {
        return true;
    }
}
