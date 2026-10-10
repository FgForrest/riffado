/**
 * The knowledge base, private and shared, against a real PostgreSQL.
 *
 * People used to be strictly per account, and the old tests pinned that as
 * "every query filters by the caller's userId". Organization people broke
 * the shape of that rule without breaking its point, which is what these
 * check: nobody reads or changes another account's private people, the
 * Organization's people are one record everyone names speakers with, and
 * only the organization account reshapes them.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

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
    people,
    recordingFolders,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

// Runs once right after the route reads the person it names, to merge
// that person away before the route's own merge.
const afterRead = vi.hoisted(() => ({
    current: null as null | {
        id: string;
        run: () => Promise<void>;
    },
}));

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
vi.mock("@/lib/knowledge/people", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@/lib/knowledge/people")>();
    return {
        ...actual,
        getPerson: async (
            ...args: Parameters<typeof actual.getPerson>
        ): ReturnType<typeof actual.getPerson> => {
            const found = await actual.getPerson(...args);
            const hook = afterRead.current;
            if (hook && hook.id === args[1]) {
                afterRead.current = null;
                await hook.run();
            }
            return found;
        },
    };
});
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
    DELETE as deletePersonRoute,
    GET as getPersonRoute,
    POST as mergePersonRoute,
    PATCH as patchPersonRoute,
} from "@/app/api/people/[id]/route";
import { GET as listPeopleRoute } from "@/app/api/people/route";
import {
    GET as getSpeakersRoute,
    PUT as putSpeakerRoute,
} from "@/app/api/recordings/[id]/speakers/route";
import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { buildNameResolver } from "@/lib/knowledge/attribution";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import {
    addPersonNotes,
    getPerson,
    listPeople,
    mergePeople,
} from "@/lib/knowledge/people";
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

function call(
    handler: unknown,
    user: string,
    path: string,
    init: RequestInit & { params?: Record<string, string> } = {},
) {
    const { params = {}, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("x-test-user", user);
    return (handler as Handler)(
        new Request(`http://localhost${path}`, { ...rest, headers }),
        { params: Promise.resolve(params) },
    );
}

/** The transcript version a speakers view shows, as the panel reads it. */
async function seenVersion(
    user: string,
    path: string,
    init: { params?: Record<string, string> } = {},
) {
    const response = await call(getSpeakersRoute, user, path, init);
    const body = (await response.json()) as {
        transcriptionId?: string;
        revision?: number;
    };
    return { transcriptionId: body.transcriptionId, revision: body.revision };
}

function json(body: unknown): RequestInit {
    return {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    };
}

describeWithDatabase("knowledge base (PostgreSQL)", () => {
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
            "knowledge",
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
        orgUserId = (await ensureOrgAccount()) ?? "";
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        orgRootId = root?.id ?? "";
    });

    async function person(
        userId: string,
        name: string,
        extra: { email?: string; notes?: string } = {},
    ): Promise<string> {
        const [row] = await db()
            .insert(people)
            .values({
                userId,
                displayName: encryptText(name),
                primaryEmail: extra.email ? encryptText(extra.email) : null,
                primaryEmailHash: extra.email ? lookupHash(extra.email) : null,
                notes: extra.notes ? encryptText(extra.notes) : null,
            })
            .returning({ id: people.id });
        return row?.id ?? "";
    }

    async function meeting(ownerId = ALICE): Promise<string> {
        await insertRecordings(db(), {
            id: REC,
            userId: ownerId,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ownerId}/rec.mp3`,
            plaudVersion: "1",
        });
        const [row] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: ownerId,
                text: encryptText(DIALOG),
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        return row?.id ?? "";
    }

    async function name(
        transcriptionId: string,
        userId: string,
        label: string,
        personId: string,
        status: "confirmed" | "suggested" = "confirmed",
    ) {
        await db().insert(transcriptSpeakers).values({
            userId,
            transcriptionId,
            label,
            personId,
            source: "user",
            status,
        });
    }

    /** "Nobody knows who this is", as the owner answered it. */
    async function unknown(
        transcriptionId: string,
        userId: string,
        label: string,
    ) {
        await db().insert(transcriptSpeakers).values({
            userId,
            transcriptionId,
            label,
            source: "user",
            status: "confirmed",
            markedUnknown: true,
            confirmedByUserId: userId,
        });
    }

    async function share() {
        await addRecordingToFolder({
            userId: ALICE,
            recordingId: REC,
            folderId: orgRootId,
        });
    }

    describe("private people stay private", () => {
        it("never shows or resolves another account's person", async () => {
            const bobs = await person(BOB, "Bob's contact");
            expect(await getPerson(ALICE, bobs)).toBeNull();
            expect(await listPeople(ALICE)).toEqual([]);
            const response = await call(
                getPersonRoute,
                ALICE,
                `/api/people/${bobs}`,
                { params: { id: bobs } },
            );
            expect(response.status).toBe(404);
        });

        it("hides tombstones from the list", async () => {
            const keep = await person(ALICE, "Jana");
            const lose = await person(ALICE, "J.");
            await mergePeople(ALICE, keep, lose);
            const listed = await call(listPeopleRoute, ALICE, "/api/people");
            const body = (await listed.json()) as { people: { id: string }[] };
            expect(body.people.map((p) => p.id)).toEqual([keep]);
        });

        it("refuses to erase or merge another account's person", async () => {
            const mine = await person(ALICE, "Mine");
            const bobs = await person(BOB, "Bob's");
            expect(
                (
                    await call(
                        deletePersonRoute,
                        ALICE,
                        `/api/people/${bobs}`,
                        { method: "DELETE", params: { id: bobs } },
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(mergePersonRoute, ALICE, `/api/people/${mine}`, {
                        method: "POST",
                        params: { id: mine },
                        ...json({ mergeIntoId: bobs }),
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(mergePersonRoute, ALICE, `/api/people/${mine}`, {
                        method: "POST",
                        params: { id: mine },
                        ...json({ mergeIntoId: mine }),
                    })
                ).status,
            ).toBe(400);
            const remaining = await db().select().from(people);
            expect(remaining).toHaveLength(2);
        });

        it("erases a person with the tombstones merged into them", async () => {
            const keep = await person(ALICE, "Jana");
            const lose = await person(ALICE, "J.");
            await mergePeople(ALICE, keep, lose);
            const response = await call(
                deletePersonRoute,
                ALICE,
                `/api/people/${keep}`,
                { method: "DELETE", params: { id: keep } },
            );
            expect(response.status).toBe(200);
            expect(await db().select().from(people)).toHaveLength(0);
        });
    });

    describe("merging", () => {
        it("repoints every label onto the winner and releases the email", async () => {
            const transcript = await meeting();
            const keep = await person(ALICE, "Jana");
            const lose = await person(ALICE, "J.", { email: "j@example.test" });
            await name(transcript, ALICE, "speaker_0", keep, "suggested");
            await name(transcript, ALICE, "speaker_0b", lose);
            await mergePeople(ALICE, keep, lose);

            const attributions = await db()
                .select()
                .from(transcriptSpeakers)
                .where(eq(transcriptSpeakers.transcriptionId, transcript));
            expect(attributions.every((row) => row.personId === keep)).toBe(
                true,
            );
            const [tombstone] = await db()
                .select()
                .from(people)
                .where(eq(people.id, lose));
            expect(tombstone?.mergedIntoId).toBe(keep);
            expect(tombstone?.primaryEmailHash).toBeNull();
        });

        it("collapses chains and follows a merged-away target", async () => {
            const a = await person(ALICE, "A");
            const b = await person(ALICE, "B");
            const c = await person(ALICE, "C");
            await mergePeople(ALICE, b, a);
            await mergePeople(ALICE, c, b);
            const rows = await db().select().from(people);
            expect(rows.find((row) => row.id === a)?.mergedIntoId).toBe(c);
            const d = await person(ALICE, "D");
            const landed = await call(
                mergePersonRoute,
                ALICE,
                `/api/people/${d}`,
                {
                    method: "POST",
                    params: { id: d },
                    ...json({ mergeIntoId: b }),
                },
            );
            const body = (await landed.json()) as { person: { id: string } };
            expect(body.person.id).toBe(c);
        });

        it("reports the winner when the target is merged away after it was read", async () => {
            const target = await person(ALICE, "Target");
            const winner = await person(ALICE, "Winner");
            const loser = await person(ALICE, "Loser");
            afterRead.current = {
                id: target,
                run: () => mergePeople(ALICE, winner, target),
            };
            const landed = await call(
                mergePersonRoute,
                ALICE,
                `/api/people/${loser}`,
                {
                    method: "POST",
                    params: { id: loser },
                    ...json({ mergeIntoId: target }),
                },
            );
            expect(afterRead.current).toBeNull();
            const body = (await landed.json()) as { person: { id: string } };
            expect(body.person.id).toBe(winner);
            expect((await getPerson(ALICE, loser))?.mergedIntoId).toBe(winner);
        });
    });

    describe("sharing promotes the names it shows", () => {
        it("turns confirmed private people into Organization people, notes kept private", async () => {
            const transcript = await meeting();
            const jana = await person(ALICE, "Jana", { notes: "likes tea" });
            const guess = await person(ALICE, "Maybe Petr");
            await name(transcript, ALICE, "speaker_0", jana);
            await name(transcript, ALICE, "speaker_1", guess, "suggested");

            // A suggestion is no answer: nothing is shared, nobody promoted.
            await expect(share()).rejects.toMatchObject({ statusCode: 409 });
            expect((await getPerson(ALICE, jana))?.scope).toBe("personal");

            // It was not Petr, and nobody knows who it was.
            await db()
                .update(transcriptSpeakers)
                .set({
                    personId: null,
                    status: "confirmed",
                    markedUnknown: true,
                })
                .where(eq(transcriptSpeakers.label, "speaker_1"));
            await share();

            const [promoted] = await db()
                .select()
                .from(people)
                .where(eq(people.id, jana));
            expect(promoted?.userId).toBe(orgUserId);
            expect(promoted?.createdByUserId).toBe(ALICE);
            expect(promoted?.notes).toBeNull();
            const [guessRow] = await db()
                .select()
                .from(people)
                .where(eq(people.id, guess));
            expect(guessRow?.userId).toBe(ALICE);

            expect((await getPerson(ALICE, jana))?.notes).toBe("likes tea");
            const bobsView = await getPerson(BOB, jana);
            expect(bobsView?.scope).toBe("org");
            expect(bobsView?.notes).toBeNull();

            // The owner's own transcript still resolves the promoted name.
            const resolve = await buildNameResolver(ALICE, transcript);
            expect(resolve?.("speaker_0")).toBe("Jana");
            expect(resolve?.("speaker_1")).toBeNull();
        });

        it("folds a private person into the Organization's record with the same email", async () => {
            const transcript = await meeting();
            const known = await person(orgUserId, "Jana Nováková", {
                email: "jana@example.test",
            });
            const mine = await person(ALICE, "Jana", {
                email: "jana@example.test",
            });
            await name(transcript, ALICE, "speaker_0", mine);
            await unknown(transcript, ALICE, "speaker_1");

            await share();

            const [attribution] = await db()
                .select()
                .from(transcriptSpeakers)
                .where(
                    and(
                        eq(transcriptSpeakers.transcriptionId, transcript),
                        eq(transcriptSpeakers.label, "speaker_0"),
                    ),
                );
            expect(attribution?.personId).toBe(known);
            const [tombstone] = await db()
                .select()
                .from(people)
                .where(eq(people.id, mine));
            expect(tombstone?.mergedIntoId).toBe(known);
        });
    });

    describe("curating Organization people", () => {
        it("lets only the organization account rename, merge or erase them", async () => {
            const transcript = await meeting();
            const jana = await person(orgUserId, "Jana");
            const dup = await person(orgUserId, "Jana N.");
            await name(transcript, ALICE, "speaker_0", jana);

            for (const [handler, init] of [
                [
                    patchPersonRoute,
                    { method: "PATCH", ...json({ displayName: "Hacked" }) },
                ],
                [
                    mergePersonRoute,
                    { method: "POST", ...json({ mergeIntoId: dup }) },
                ],
                [deletePersonRoute, { method: "DELETE" }],
            ] as const) {
                const response = await call(
                    handler,
                    BOB,
                    `/api/people/${jana}`,
                    { ...init, params: { id: jana } },
                );
                expect(response.status).toBe(403);
            }

            const renamed = await call(
                patchPersonRoute,
                orgUserId,
                `/api/people/${jana}`,
                {
                    method: "PATCH",
                    params: { id: jana },
                    ...json({ displayName: "Jana Nováková" }),
                },
            );
            expect(renamed.status).toBe(200);
            const resolve = await buildNameResolver(ALICE, transcript);
            expect(resolve?.("speaker_0")).toBe("Jana Nováková");

            const erased = await call(
                deletePersonRoute,
                orgUserId,
                `/api/people/${jana}`,
                { method: "DELETE", params: { id: jana } },
            );
            expect(erased.status).toBe(200);
            // Unlinked, not deleted: the label is someone's attribution row.
            const [row] = await db()
                .select()
                .from(transcriptSpeakers)
                .where(eq(transcriptSpeakers.transcriptionId, transcript));
            expect(row?.personId).toBeNull();
        });

        it("keeps everyone's private notes when Organization people merge", async () => {
            const keep = await person(orgUserId, "Jana");
            const lose = await person(orgUserId, "J.");
            await addPersonNotes(keep, ALICE, "met in Brno");
            await addPersonNotes(lose, ALICE, "likes tea");
            await addPersonNotes(lose, BOB, "Bob's note");
            await mergePeople(orgUserId, keep, lose);
            expect((await getPerson(ALICE, keep))?.notes).toBe(
                "met in Brno\n\nlikes tea",
            );
            expect((await getPerson(BOB, keep))?.notes).toBe("Bob's note");
        });

        it("lets anyone fold a private duplicate into an Organization person, never the reverse", async () => {
            const org = await person(orgUserId, "Jana");
            const mine = await person(BOB, "Jana B.");
            await expect(mergePeople(BOB, mine, org)).rejects.toMatchObject({
                statusCode: 403,
            });
            await mergePeople(BOB, org, mine);
            const [tombstone] = await db()
                .select()
                .from(people)
                .where(eq(people.id, mine));
            expect(tombstone?.mergedIntoId).toBe(org);
        });

        it("lists Organization people for everyone, marked as such", async () => {
            await person(orgUserId, "Jana");
            await person(BOB, "Private");
            const listed = await listPeople(BOB);
            expect(listed.map((p) => [p.displayName, p.scope]).sort()).toEqual([
                ["Jana", "org"],
                ["Private", "personal"],
            ]);
            expect((await listPeople(orgUserId)).map((p) => p.scope)).toEqual([
                "org",
            ]);
        });
    });

    describe("naming the speakers of a shared recording", () => {
        let ownTranscript = "";

        beforeEach(async () => {
            ownTranscript = await meeting();
            const jana = await person(ALICE, "Jana");
            await name(ownTranscript, ALICE, "speaker_0", jana);
            await unknown(ownTranscript, ALICE, "speaker_1");
            await share();
        });

        /** A speaker change in the Organization view, on the version it shows. */
        async function orgChange(user: string, body: object, query = "") {
            const path = `/api/recordings/${REC}/speakers?view=org${query}`;
            return call(putSpeakerRoute, user, path, {
                method: "PUT",
                params: { id: REC },
                ...json({
                    ...(await seenVersion(user, path, { params: { id: REC } })),
                    ...body,
                }),
            });
        }

        it("names on the owner's transcript, with Organization people only", async () => {
            const bobsPrivate = await person(BOB, "Bob's friend");
            // Only Organization people name its speakers.
            expect(
                (
                    await orgChange(orgUserId, {
                        label: "speaker_1",
                        personId: bobsPrivate,
                    })
                ).status,
            ).toBe(404);

            const response = await orgChange(orgUserId, {
                label: "speaker_1",
                displayName: "Petr",
            });
            expect(response.status).toBe(200);

            // One recording: the owner's transcript, and no other.
            const rows = await db()
                .select({ id: transcriptions.id })
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, REC));
            expect(rows).toEqual([{ id: ownTranscript }]);
            const names = await buildNameResolver(ALICE, ownTranscript);
            expect(names?.("speaker_0")).toBe("Jana");
            expect(names?.("speaker_1")).toBe("Petr");

            const orgPeople = await listPeople(orgUserId);
            expect(orgPeople.map((p) => p.displayName).sort()).toEqual([
                "Jana",
                "Petr",
            ]);

            const read = await call(
                getSpeakersRoute,
                BOB,
                `/api/recordings/${REC}/speakers?view=org`,
                { params: { id: REC } },
            );
            const body = (await read.json()) as {
                transcriptionId: string;
                speakers: { label: string }[];
            };
            expect(body.transcriptionId).toBe(ownTranscript);
            expect(body.speakers.map((s) => s.label).sort()).toEqual([
                "speaker_0",
                "speaker_1",
            ]);
        });

        it("never shows a private person in the Organization view", async () => {
            // A name no share promoted: written outside it, as a recording
            // shared before sharing promoted names could still hold.
            const secret = await person(ALICE, "Dr. Private");
            await db()
                .update(transcriptSpeakers)
                .set({ personId: secret, markedUnknown: false })
                .where(
                    and(
                        eq(transcriptSpeakers.transcriptionId, ownTranscript),
                        eq(transcriptSpeakers.label, "speaker_1"),
                    ),
                );
            const read = await call(
                getSpeakersRoute,
                BOB,
                `/api/recordings/${REC}/speakers?view=org`,
                { params: { id: REC } },
            );
            const body = (await read.json()) as {
                speakers: { label: string; personName: string | null }[];
            };
            expect(
                body.speakers.find((s) => s.label === "speaker_1")
                    ?.personName ?? null,
            ).toBeNull();
        });

        it("shows every source of the owner's transcript in the Organization view", async () => {
            await unshareRecording(ALICE, REC, { withdraw: true });
            const [plaud] = await db()
                .insert(transcriptions)
                .values({
                    recordingId: REC,
                    userId: ALICE,
                    text: encryptText(DIALOG),
                    provider: "plaud",
                    model: "plaud",
                    source: "plaud",
                })
                .returning({ id: transcriptions.id });
            await unknown(plaud?.id ?? "", ALICE, "speaker_0");
            await unknown(plaud?.id ?? "", ALICE, "speaker_1");

            await share();

            const read = await call(
                getSpeakersRoute,
                BOB,
                `/api/recordings/${REC}/speakers?view=org&source=plaud`,
                { params: { id: REC } },
            );
            const body = (await read.json()) as { transcriptionId: string };
            expect(body.transcriptionId).toBe(plaud?.id);
        });

        it("carries names through an Organization re-transcription by speech overlap", async () => {
            const turns = (first: string, second: string) => [
                { speaker: first, startMs: 0, endMs: 10_000, text: "Hello." },
                {
                    speaker: second,
                    startMs: 10_000,
                    endMs: 20_000,
                    text: "Hi there.",
                },
            ];
            const orgRun = (speakers: [string, string]) =>
                upsertTranscription({
                    userId: ALICE,
                    actorUserId: orgUserId,
                    recordingId: REC,
                    text: DIALOG,
                    detectedLanguage: "en",
                    source: "riffado",
                    provider: "openai",
                    model: "gpt-4o-transcribe-diarize",
                    turns: turns(...speakers),
                });
            // The shared transcript has no timings, so the first timed run
            // can only pair its speakers by order, which leaves Jana a
            // suggestion; the organization account confirms her on the
            // timed text.
            expect((await orgRun(["speaker_0", "speaker_1"])).committed).toBe(
                true,
            );
            const orgTranscript = { id: ownTranscript };
            const jana = (await listPeople(orgUserId))[0]?.id ?? "";
            await db()
                .update(transcriptSpeakers)
                .set({ status: "confirmed", source: "user" })
                .where(
                    and(
                        eq(
                            transcriptSpeakers.transcriptionId,
                            orgTranscript?.id ?? "",
                        ),
                        eq(transcriptSpeakers.label, "speaker_0"),
                        eq(transcriptSpeakers.personId, jana),
                    ),
                );

            // The provider numbers the same two voices the other way round.
            await orgRun(["speaker_1", "speaker_0"]);

            const rows = await db()
                .select()
                .from(transcriptSpeakers)
                .where(
                    eq(
                        transcriptSpeakers.transcriptionId,
                        orgTranscript?.id ?? "",
                    ),
                )
                .orderBy(transcriptSpeakers.label);
            expect(rows).toEqual([
                expect.objectContaining({
                    label: "speaker_1",
                    personId: jana,
                    status: "confirmed",
                }),
            ]);
        });
    });
});
