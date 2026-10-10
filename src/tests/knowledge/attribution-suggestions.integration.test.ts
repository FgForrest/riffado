/**
 * What a person can answer about a speaker label, and what machine
 * suggestions may do around those answers, against a real PostgreSQL.
 *
 * - "Unknown" is an answer, confirmed by the person who gave it.
 * - Clearing takes an answer back and leaves the label open.
 * - Rejecting a suggestion is remembered per (label, person), so the same
 *   wrong name never returns, even after other suggestions came and went.
 * - A suggestion never overwrites anything.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq, sql } from "drizzle-orm";
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
    people,
    recordingFolders,
    recordings,
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
vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth-server", async () => {
    const { AppError, ErrorCode } =
        await vi.importActual<typeof import("@/lib/errors")>("@/lib/errors");
    return {
        requireApiSession: vi.fn(async (request: Request) => {
            const id = request.headers.get("x-test-user");
            if (!id) {
                throw new AppError(
                    ErrorCode.AUTH_SESSION_MISSING,
                    "Unauthorized",
                    401,
                );
            }
            return { user: { id, email: `${id}@example.test` } };
        }),
    };
});

import {
    GET as getSpeakersRoute,
    PUT as putSpeakerRoute,
} from "@/app/api/recordings/[id]/speakers/route";
import { db as appDb } from "@/db";
import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder } from "@/lib/folders/folders";
import {
    copyMatchingSpeakerAttributions,
    insertSuggestionsInTx,
    lockForSpeakerChange,
    rejectSuggestion,
    type SuggestedSpeaker,
    setTranscriptSpeaker,
} from "@/lib/knowledge/attribution";
import { mergePeople } from "@/lib/knowledge/people";
import { ensureOrgAccount } from "@/lib/org/account";
import { upsertTranscription } from "@/lib/transcription/persist";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";
const REC = "rec-meeting";
const DIALOG = "speaker_0: Hello.\nspeaker_1: Hi there.";

type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

function request(user: string, query: string, init: RequestInit = {}) {
    return new Request(
        `http://localhost/api/recordings/${REC}/speakers${query}`,
        {
            ...init,
            headers: {
                "content-type": "application/json",
                "x-test-user": user,
            },
        },
    );
}

type Tx = Parameters<Parameters<typeof appDb.transaction>[0]>[0];

/**
 * Run `work` in a transaction that stays open, holding its locks, until
 * `commit` is called: another writer caught in the middle of its work.
 */
async function holdTransaction(work: (tx: Tx) => Promise<void>) {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    let ready = () => {};
    const worked = new Promise<void>((resolve) => {
        ready = resolve;
    });
    const done = appDb.transaction(async (tx) => {
        await work(tx);
        ready();
        await released;
    });
    await Promise.race([worked, done]);
    return {
        commit: async () => {
            release();
            await done;
        },
    };
}

/** Whether `promise` is still pending after a moment: waiting on a lock. */
async function stillWaiting(promise: Promise<unknown>): Promise<boolean> {
    const pending = Symbol("pending");
    const first = await Promise.race([
        promise.then(
            () => null,
            () => null,
        ),
        new Promise((resolve) => setTimeout(() => resolve(pending), 300)),
    ]);
    return first === pending;
}

/** The transcript version the view shows, as the panel reads it. */
async function shownVersion(user: string, query = "") {
    const response = await (getSpeakersRoute as unknown as Handler)(
        request(user, query),
        { params: Promise.resolve({ id: REC }) },
    );
    const body = (await response.json()) as {
        transcriptionId?: string;
        revision?: number;
    };
    return { transcriptionId: body.transcriptionId, revision: body.revision };
}

/** A change as the panel sends it: naming the version it just read. */
async function put(user: string, body: object, query = "") {
    return (putSpeakerRoute as unknown as Handler)(
        request(user, query, {
            method: "PUT",
            body: JSON.stringify({
                ...(await shownVersion(user, query)),
                ...body,
            }),
        }),
        { params: Promise.resolve({ id: REC }) },
    );
}

describeWithDatabase("speaker answers and suggestions (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let transcriptId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "speaker_answers",
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
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        await insertRecordings(db(), {
            id: REC,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/rec.mp3`,
            plaudVersion: "1",
        });
        const [row] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: ALICE,
                text: encryptText(DIALOG),
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        transcriptId = row?.id ?? "";
    });

    async function person(userId: string, name: string): Promise<string> {
        const [row] = await db()
            .insert(people)
            .values({ userId, displayName: encryptText(name) })
            .returning({ id: people.id });
        return row?.id ?? "";
    }

    async function speakerRows() {
        return db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, transcriptId));
    }

    async function rejections() {
        return db()
            .select({
                label: transcriptSpeakerRejections.label,
                personId: transcriptSpeakerRejections.personId,
            })
            .from(transcriptSpeakerRejections)
            .where(
                eq(transcriptSpeakerRejections.transcriptionId, transcriptId),
            );
    }

    function suggest(rows: SuggestedSpeaker[]) {
        return appDb.transaction((tx) =>
            insertSuggestionsInTx(tx, {
                userId: ALICE,
                transcriptionId: transcriptId,
                rows,
            }),
        );
    }

    function suggestion(label: string, personId: string | null) {
        return { label, personId, source: "heuristic" as const };
    }

    describe("the speakers route", () => {
        it("stores unknown as a confirmed answer, with who gave it", async () => {
            const response = await put(ALICE, {
                label: "speaker_1",
                unknown: true,
            });
            expect(response.status).toBe(200);
            const [row] = await speakerRows();
            expect(row).toMatchObject({
                label: "speaker_1",
                personId: null,
                status: "confirmed",
                source: "user",
                markedUnknown: true,
                confirmedByUserId: ALICE,
            });
            const body = (await response.json()) as {
                speakers: { label: string; markedUnknown: boolean }[];
            };
            expect(body.speakers).toEqual([
                expect.objectContaining({
                    label: "speaker_1",
                    markedUnknown: true,
                }),
            ]);
        });

        it("records who named a speaker", async () => {
            const jana = await person(ALICE, "Jana");
            await put(ALICE, { label: "speaker_0", personId: jana });
            const [row] = await speakerRows();
            expect(row).toMatchObject({
                personId: jana,
                markedUnknown: false,
                confirmedByUserId: ALICE,
            });
        });

        it("clears an answer by deleting the row", async () => {
            const jana = await person(ALICE, "Jana");
            await put(ALICE, { label: "speaker_0", personId: jana });
            await put(ALICE, { label: "speaker_1", unknown: true });
            expect(await speakerRows()).toHaveLength(2);

            await put(ALICE, { label: "speaker_0" });
            await put(ALICE, { label: "speaker_1" });
            expect(await speakerRows()).toEqual([]);
        });

        it("rejects a suggestion: remembers the pair and removes the row", async () => {
            const jana = await person(ALICE, "Jana");
            await suggest([suggestion("speaker_0", jana)]);
            expect(await speakerRows()).toHaveLength(1);

            const response = await put(ALICE, {
                label: "speaker_0",
                personId: jana,
                reject: true,
            });
            expect(response.status).toBe(200);
            expect(await speakerRows()).toEqual([]);
            expect(await rejections()).toEqual([
                { label: "speaker_0", personId: jana },
            ]);
        });

        it("needs the person to reject, and only one the caller can see", async () => {
            expect(
                (await put(ALICE, { label: "speaker_0", reject: true })).status,
            ).toBe(400);
            const bobs = await person(BOB, "Bob's contact");
            expect(
                (
                    await put(ALICE, {
                        label: "speaker_0",
                        personId: bobs,
                        reject: true,
                    })
                ).status,
            ).toBe(404);
            expect(await rejections()).toEqual([]);
        });

        it("keys an overlong label instead of refusing it", async () => {
            const label = `speaker_${"x".repeat(70)}`;
            expect(
                (await put(ALICE, { label: ` ${label}`, unknown: true }))
                    .status,
            ).toBe(200);
            const [row] = await speakerRows();
            expect(row?.label).toBe(label.slice(0, 64));
        });
    });

    describe("every change names the version it was made on", () => {
        it("refuses a change made before a re-transcription", async () => {
            const seen = await shownVersion(ALICE);
            await upsertTranscription({
                userId: ALICE,
                recordingId: REC,
                text: "speaker_0: New.\nspeaker_1: Run.",
                detectedLanguage: "en",
                source: "riffado",
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
            });
            const response = await put(ALICE, {
                ...seen,
                label: "speaker_0",
                unknown: true,
            });
            expect(response.status).toBe(409);
            expect(await speakerRows()).toEqual([]);
        });

        it("refuses a change made on a transcript that was erased and written again", async () => {
            const seen = await shownVersion(ALICE);
            await db()
                .delete(transcriptions)
                .where(eq(transcriptions.id, transcriptId));
            // The new transcript starts at revision 0 again.
            await db()
                .insert(transcriptions)
                .values({
                    recordingId: REC,
                    userId: ALICE,
                    text: encryptText(DIALOG),
                    provider: "openai",
                    model: "gpt-4o-transcribe-diarize",
                    source: "riffado",
                });
            expect(seen.revision).toBe(0);
            const response = await put(ALICE, {
                ...seen,
                label: "speaker_0",
                unknown: true,
            });
            expect(response.status).toBe(409);
        });

        it("refuses another account's transcript", async () => {
            await insertRecordings(db(), {
                id: "rec-bob",
                userId: BOB,
                deviceSn: "SN-2",
                plaudFileId: "plaud-2",
                filename: encryptText("Bob's"),
                duration: 60_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:01:00Z"),
                filesize: 11,
                fileMd5: "1".repeat(32),
                storageType: "local",
                storagePath: `${BOB}/rec.mp3`,
                plaudVersion: "1",
            });
            const [bobs] = await db()
                .insert(transcriptions)
                .values({
                    recordingId: "rec-bob",
                    userId: BOB,
                    text: encryptText(DIALOG),
                    provider: "openai",
                    model: "gpt-4o-transcribe-diarize",
                    source: "riffado",
                })
                .returning({ id: transcriptions.id });
            const response = await put(ALICE, {
                transcriptionId: bobs?.id,
                revision: 0,
                label: "speaker_0",
                unknown: true,
            });
            expect(response.status).toBe(409);
            await expect(
                setTranscriptSpeaker({
                    userId: ALICE,
                    transcriptionId: bobs?.id ?? "",
                    revision: 0,
                    label: "speaker_0",
                    personId: null,
                    source: "user",
                    status: "confirmed",
                    markedUnknown: true,
                }),
            ).rejects.toMatchObject({ statusCode: 404 });
            const rows = await db().select().from(transcriptSpeakers);
            expect(rows).toEqual([]);
        });
    });

    describe("suggestions", () => {
        it("never offers a rejected person again for that label", async () => {
            const jana = await person(ALICE, "Jana");
            await suggest([suggestion("speaker_0", jana)]);
            await rejectSuggestion({
                userId: ALICE,
                transcriptionId: transcriptId,
                revision: 0,
                label: "speaker_0",
                personId: jana,
            });
            expect(await suggest([suggestion("speaker_0", jana)])).toBe(0);
            expect(await speakerRows()).toEqual([]);
        });

        it("keeps every rejection when suggestions alternate", async () => {
            const jana = await person(ALICE, "Jana");
            const petr = await person(ALICE, "Petr");
            const reject = (personId: string) =>
                rejectSuggestion({
                    userId: ALICE,
                    transcriptionId: transcriptId,
                    revision: 0,
                    label: "speaker_0",
                    personId,
                });

            await suggest([suggestion("speaker_0", jana)]);
            await reject(jana);
            expect(await suggest([suggestion("speaker_0", petr)])).toBe(1);
            await reject(petr);
            expect(await suggest([suggestion("speaker_0", jana)])).toBe(0);
            expect(await suggest([suggestion("speaker_0", petr)])).toBe(0);
            expect(await speakerRows()).toEqual([]);
        });

        it("only blocks the rejected label", async () => {
            const jana = await person(ALICE, "Jana");
            await rejectSuggestion({
                userId: ALICE,
                transcriptionId: transcriptId,
                revision: 0,
                label: "speaker_0",
                personId: jana,
            });
            expect(await suggest([suggestion("speaker_1", jana)])).toBe(1);
        });

        it("never replaces a confirmed row or an answer of unknown", async () => {
            const jana = await person(ALICE, "Jana");
            const petr = await person(ALICE, "Petr");
            await put(ALICE, { label: "speaker_0", personId: jana });
            await put(ALICE, { label: "speaker_1", unknown: true });

            expect(
                await suggest([
                    suggestion("speaker_0", petr),
                    suggestion("speaker_1", petr),
                ]),
            ).toBe(0);
            const rows = await speakerRows();
            expect(
                rows.map((row) => [row.label, row.personId, row.status]),
            ).toEqual(
                expect.arrayContaining([
                    ["speaker_0", jana, "confirmed"],
                    ["speaker_1", null, "confirmed"],
                ]),
            );
        });

        it("drops suggestions without a person", async () => {
            expect(await suggest([suggestion("speaker_0", null)])).toBe(0);
            expect(await speakerRows()).toEqual([]);
        });

        it("takes a rejection back when a person confirms that name", async () => {
            const jana = await person(ALICE, "Jana");
            await rejectSuggestion({
                userId: ALICE,
                transcriptionId: transcriptId,
                revision: 0,
                label: "speaker_0",
                personId: jana,
            });
            await setTranscriptSpeaker({
                userId: ALICE,
                transcriptionId: transcriptId,
                revision: 0,
                label: "speaker_0",
                personId: jana,
                source: "user",
                status: "confirmed",
                confirmedByUserId: ALICE,
            });
            expect(await rejections()).toEqual([]);
        });
    });

    it("moves rejections onto the person a merge keeps", async () => {
        const jana = await person(ALICE, "Jana");
        const duplicate = await person(ALICE, "J. Nováková");
        await rejectSuggestion({
            userId: ALICE,
            transcriptionId: transcriptId,
            revision: 0,
            label: "speaker_0",
            personId: duplicate,
        });
        await mergePeople(ALICE, jana, duplicate);
        expect(await rejections()).toEqual([
            { label: "speaker_0", personId: jana },
        ]);
        expect(await suggest([suggestion("speaker_0", jana)])).toBe(0);
    });

    it("shows suggestions only to whoever may act on them", async () => {
        const orgUserId = (await ensureOrgAccount()) ?? "";
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        const share = () =>
            addRecordingToFolder({
                userId: ALICE,
                recordingId: REC,
                folderId: root?.id ?? "",
            });
        const jana = await person(ALICE, "Jana");
        await suggest([suggestion("speaker_0", jana)]);
        const labelsSeenBy = async (user: string, query: string) => {
            const response = await (getSpeakersRoute as unknown as Handler)(
                request(user, query),
                { params: Promise.resolve({ id: REC }) },
            );
            const body = (await response.json()) as {
                speakers: { label: string; status: string }[];
            };
            return body.speakers.map((row) => `${row.label}:${row.status}`);
        };

        // The owner reviews suggestions on their own transcript, and must
        // before sharing: a suggestion is no answer.
        expect(await labelsSeenBy(ALICE, "")).toEqual(["speaker_0:suggested"]);
        await expect(share()).rejects.toMatchObject({ statusCode: 409 });
        await put(ALICE, { label: "speaker_0", personId: jana });
        await put(ALICE, { label: "speaker_1", unknown: true });
        await share();

        // Shared, the organization account curates it.
        await put(orgUserId, { label: "speaker_0" }, "?view=org");
        const orgJana = await person(orgUserId, "Jana N.");
        await appDb.transaction((tx) =>
            insertSuggestionsInTx(tx, {
                userId: ALICE,
                transcriptionId: transcriptId,
                rows: [suggestion("speaker_0", orgJana)],
            }),
        );
        expect((await labelsSeenBy(orgUserId, "?view=org")).sort()).toEqual([
            "speaker_0:suggested",
            "speaker_1:confirmed",
        ]);
        expect(await labelsSeenBy(BOB, "?view=org")).toEqual([
            "speaker_1:confirmed",
        ]);
        // The owner may not act on it while shared, in either view.
        expect(await labelsSeenBy(ALICE, "?view=org")).toEqual([
            "speaker_1:confirmed",
        ]);
        expect(await labelsSeenBy(ALICE, "")).toEqual(["speaker_1:confirmed"]);
    });

    it("keeps unknown and the confirmer when shared", async () => {
        const orgUserId = (await ensureOrgAccount()) ?? "";
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await put(ALICE, { label: "speaker_0", displayName: "Petr" });
        await put(ALICE, { label: "speaker_1", unknown: true });
        await addRecordingToFolder({
            userId: ALICE,
            recordingId: REC,
            folderId: root?.id ?? "",
        });

        // One recording: the owner's rows are what the Organization reads,
        // naming the human who confirmed each.
        const shared = await db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, transcriptId))
            .orderBy(transcriptSpeakers.label);
        expect(shared).toEqual([
            expect.objectContaining({
                label: "speaker_0",
                userId: ALICE,
                status: "confirmed",
                markedUnknown: false,
                confirmedByUserId: ALICE,
            }),
            expect.objectContaining({
                label: "speaker_1",
                userId: ALICE,
                personId: null,
                status: "confirmed",
                markedUnknown: true,
                confirmedByUserId: ALICE,
            }),
        ]);
        const [petr] = await db()
            .select({ userId: people.userId })
            .from(people)
            .where(eq(people.id, shared[0]?.personId ?? ""));
        expect(petr?.userId).toBe(orgUserId);
    });
    describe("serialized with transcript rewrites", () => {
        /** Lock the recording as a transcript rewrite does. */
        async function lockAsRewrite(tx: Tx) {
            await tx
                .select({ id: recordings.id })
                .from(recordings)
                .where(eq(recordings.id, REC))
                .for("update");
        }

        it("waits for a rewrite in progress, then refuses a change made before it", async () => {
            const rewrite = await holdTransaction(async (tx) => {
                await lockAsRewrite(tx);
                await tx
                    .update(transcriptions)
                    .set({ revision: sql`${transcriptions.revision} + 1` })
                    .where(eq(transcriptions.id, transcriptId));
            });
            const outcome = setTranscriptSpeaker({
                userId: ALICE,
                transcriptionId: transcriptId,
                revision: 0,
                label: "speaker_0",
                personId: null,
                source: "user",
                status: "confirmed",
                markedUnknown: true,
            }).then(
                () => "written",
                (error: { statusCode?: number }) => error.statusCode,
            );
            expect(await stillWaiting(outcome)).toBe(true);
            await rewrite.commit();
            expect(await outcome).toBe(409);
            expect(await speakerRows()).toEqual([]);
        });

        it("merges the rows a rewrite in progress writes, once it commits", async () => {
            const jana = await person(ALICE, "Jana");
            const duplicate = await person(ALICE, "J. Nováková");
            await put(ALICE, { label: "speaker_0", personId: duplicate });
            // The rewrite replaces the rows, as the hook does.
            const rewrite = await holdTransaction(async (tx) => {
                await lockAsRewrite(tx);
                const rows = await tx
                    .select()
                    .from(transcriptSpeakers)
                    .where(
                        eq(transcriptSpeakers.transcriptionId, transcriptId),
                    );
                await tx
                    .delete(transcriptSpeakers)
                    .where(
                        eq(transcriptSpeakers.transcriptionId, transcriptId),
                    );
                await tx
                    .insert(transcriptSpeakers)
                    .values(rows.map(({ id: _id, ...row }) => row));
            });
            const merge = mergePeople(ALICE, jana, duplicate);
            expect(await stillWaiting(merge)).toBe(true);
            await rewrite.commit();
            await merge;
            expect((await speakerRows()).map((row) => row.personId)).toEqual([
                jana,
            ]);
        });

        it("writes a row still naming a merged-away person as the person kept", async () => {
            const jana = await person(ALICE, "Jana");
            const duplicate = await person(ALICE, "J. Nováková");
            await put(ALICE, { label: "speaker_0", personId: duplicate });
            // What a merge committing under a rewrite's read would leave.
            await db()
                .update(people)
                .set({ mergedIntoId: jana })
                .where(eq(people.id, duplicate));
            await upsertTranscription({
                userId: ALICE,
                recordingId: REC,
                text: DIALOG,
                detectedLanguage: "en",
                source: "riffado",
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
            });
            expect((await speakerRows()).map((row) => row.personId)).toEqual([
                jana,
            ]);
        });

        it("offers no suggestion rejected while it was being copied", async () => {
            const jana = await person(ALICE, "Jana");
            const [plaud] = await db()
                .insert(transcriptions)
                .values({
                    recordingId: REC,
                    userId: ALICE,
                    text: encryptText(
                        "Speaker 1: Hello.\nSpeaker 2: Hi there.",
                    ),
                    provider: "plaud",
                    model: "plaud",
                    source: "plaud",
                })
                .returning({ id: transcriptions.id });
            await db()
                .insert(transcriptSpeakers)
                .values({
                    userId: ALICE,
                    transcriptionId: plaud?.id ?? "",
                    label: "Speaker 1",
                    personId: jana,
                    source: "user",
                    status: "confirmed",
                    confirmedByUserId: ALICE,
                });
            // A person rejects Jana for speaker_0 as the copy starts.
            const change = await holdTransaction(async (tx) => {
                await lockForSpeakerChange(tx, {
                    userId: ALICE,
                    transcriptionId: transcriptId,
                    revision: 0,
                });
                await tx.insert(transcriptSpeakerRejections).values({
                    userId: ALICE,
                    transcriptionId: transcriptId,
                    label: "speaker_0",
                    personId: jana,
                });
            });
            const copied = copyMatchingSpeakerAttributions({
                userId: ALICE,
                recordingId: REC,
                sourceSource: "plaud",
                targetSource: "riffado",
                writer: { actorUserId: ALICE, orgUserId: null },
            });
            expect(await stillWaiting(copied)).toBe(true);
            await change.commit();
            expect(await copied).toBe(0);
            expect(await speakerRows()).toEqual([]);
        });
    });

    describe("a merge meeting two answers about one label", () => {
        it("keeps the confirmation and drops the rejection", async () => {
            const jana = await person(ALICE, "Jana");
            const duplicate = await person(ALICE, "J. Nováková");
            await put(ALICE, { label: "speaker_0", personId: jana });
            await rejectSuggestion({
                userId: ALICE,
                transcriptionId: transcriptId,
                revision: 0,
                label: "speaker_0",
                personId: duplicate,
            });
            await mergePeople(ALICE, jana, duplicate);
            expect(await rejections()).toEqual([]);
            expect(
                (await speakerRows()).map((row) => [row.personId, row.status]),
            ).toEqual([[jana, "confirmed"]]);
        });

        it("drops a suggestion the moved rejection rules out", async () => {
            const jana = await person(ALICE, "Jana");
            const duplicate = await person(ALICE, "J. Nováková");
            await suggest([suggestion("speaker_0", jana)]);
            await rejectSuggestion({
                userId: ALICE,
                transcriptionId: transcriptId,
                revision: 0,
                label: "speaker_0",
                personId: duplicate,
            });
            await mergePeople(ALICE, jana, duplicate);
            expect(await speakerRows()).toEqual([]);
            expect(await rejections()).toEqual([
                { label: "speaker_0", personId: jana },
            ]);
        });
    });

    describe("the Organization view", () => {
        /** Shared once both speakers are answered: nobody Alice knows. */
        async function share(): Promise<string> {
            await put(ALICE, { label: "speaker_0", unknown: true });
            await put(ALICE, { label: "speaker_1", unknown: true });
            const orgUserId = (await ensureOrgAccount()) ?? "";
            const [root] = await db()
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, orgUserId));
            await addRecordingToFolder({
                userId: ALICE,
                recordingId: REC,
                folderId: root?.id ?? "",
            });
            return orgUserId;
        }

        it("lets only the organization account refuse a suggestion", async () => {
            const orgUserId = await share();
            // Take the answer back, leaving the label open to a suggestion.
            await put(orgUserId, { label: "speaker_0" }, "?view=org");
            const orgJana = await person(orgUserId, "Jana N.");
            await appDb.transaction((tx) =>
                insertSuggestionsInTx(tx, {
                    userId: ALICE,
                    transcriptionId: transcriptId,
                    rows: [suggestion("speaker_0", orgJana)],
                }),
            );
            const reject = {
                label: "speaker_0",
                personId: orgJana,
                reject: true,
            };

            expect((await put(BOB, reject, "?view=org")).status).toBe(403);
            const refused = await db()
                .select()
                .from(transcriptSpeakerRejections)
                .where(
                    eq(
                        transcriptSpeakerRejections.transcriptionId,
                        transcriptId,
                    ),
                );
            expect(refused).toEqual([]);

            expect((await put(orgUserId, reject, "?view=org")).status).toBe(
                200,
            );
            const kept = await db()
                .select({ label: transcriptSpeakerRejections.label })
                .from(transcriptSpeakerRejections)
                .where(
                    eq(
                        transcriptSpeakerRejections.transcriptionId,
                        transcriptId,
                    ),
                );
            expect(kept).toEqual([{ label: "speaker_0" }]);
        });

        it("tells only the organization account who confirmed a name", async () => {
            const orgUserId = await share();
            const confirmers = async (user: string) => {
                const response = await (getSpeakersRoute as unknown as Handler)(
                    request(user, "?view=org"),
                    { params: Promise.resolve({ id: REC }) },
                );
                const body = (await response.json()) as {
                    speakers: { confirmedByUserId: string | null }[];
                };
                return body.speakers.map((row) => row.confirmedByUserId);
            };
            expect(await confirmers(BOB)).toEqual([null, null]);
            expect(await confirmers(ALICE)).toEqual([null, null]);
            expect(await confirmers(orgUserId)).toEqual([ALICE, ALICE]);
        });
    });
});
