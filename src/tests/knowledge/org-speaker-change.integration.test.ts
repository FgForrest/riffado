/**
 * Changing a speaker of a shared recording, against a real PostgreSQL.
 *
 * A shared recording is one recording: the organization account's change
 * lands on the owner's transcript, and only on the text it was made on.
 * The owner and members may not change it, and after a withdrawal the
 * organization account may not either, while the owner may again.
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

const { dbProxy, dbRef, mockEnv, hooks } = vi.hoisted(() => {
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
        // Run once, at the start of the next speaker change.
        hooks: {
            beforeChange: null as null | (() => Promise<void>),
        },
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
// Another writer committing between the route's checks and the change.
vi.mock("@/lib/knowledge/speaker-changes", async () => {
    const actual = await vi.importActual<
        typeof import("@/lib/knowledge/speaker-changes")
    >("@/lib/knowledge/speaker-changes");
    return {
        ...actual,
        changeTranscriptSpeaker: async (
            ...args: Parameters<typeof actual.changeTranscriptSpeaker>
        ) => {
            const run = hooks.beforeChange;
            hooks.beforeChange = null;
            await run?.();
            return actual.changeTranscriptSpeaker(...args);
        },
    };
});

import {
    GET as getSpeakersRoute,
    PUT as putSpeakerRoute,
} from "@/app/api/recordings/[id]/speakers/route";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";
import { upsertTranscription } from "@/lib/transcription/persist";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const BOB = "user-bob";
const REC = "rec-shared";
const MODEL = "scribe_v2+diarize";

type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

function request(user: string, init: RequestInit = {}, view = "org") {
    return new Request(
        `http://localhost/api/recordings/${REC}/speakers${view === "org" ? "?view=org" : ""}`,
        {
            ...init,
            headers: {
                "content-type": "application/json",
                "x-test-user": user,
            },
        },
    );
}

async function shownVersion(user: string, view = "org") {
    const response = await (getSpeakersRoute as unknown as Handler)(
        request(user, {}, view),
        { params: Promise.resolve({ id: REC }) },
    );
    const body = (await response.json()) as {
        transcriptionId: string;
        revision: number;
    };
    return { transcriptionId: body.transcriptionId, revision: body.revision };
}

async function put(
    user: string,
    seen: { transcriptionId: string; revision: number },
    body: object,
    view = "org",
) {
    return (putSpeakerRoute as unknown as Handler)(
        request(
            user,
            {
                method: "PUT",
                body: JSON.stringify({ ...seen, ...body }),
            },
            view,
        ),
        { params: Promise.resolve({ id: REC }) },
    );
}

function turn(speaker: string, startMs: number, endMs: number, text: string) {
    return { speaker, startMs, endMs, text };
}

describeWithDatabase(
    "changing a speaker of a shared recording (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;
        let orgUserId = "";

        function db() {
            if (!database) throw new Error("test database was not initialized");
            return database.db;
        }

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "org_speaker_change",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
        }, 120_000);

        afterAll(async () => {
            dbRef.current = null;
            await database?.dispose();
        }, 30_000);

        beforeEach(async () => {
            hooks.beforeChange = null;
            await db().delete(users);
            await db()
                .insert(users)
                .values([
                    { id: OWNER, email: "owner@example.test" },
                    { id: BOB, email: "bob@example.test" },
                ]);
            orgUserId = (await ensureOrgAccount()) ?? "";
            await insertRecordings(db(), {
                id: REC,
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: "plaud-1",
                filename: encryptText("Weekly"),
                duration: 60_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:01:00Z"),
                filesize: 11,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${OWNER}/rec.mp3`,
                plaudVersion: "1",
            });
        });

        /** The owner's transcript, with Jana and Petr named on it. */
        async function namedTranscript() {
            const [row] = await db()
                .insert(transcriptions)
                .values({
                    recordingId: REC,
                    userId: OWNER,
                    text: encryptText(
                        firstTurns
                            .map((t) => `${t.speaker}: ${t.text}`)
                            .join("\n"),
                    ),
                    turns: encryptJsonField(firstTurns),
                    provider: "elevenlabs",
                    model: MODEL,
                    source: "riffado",
                })
                .returning({ id: transcriptions.id });
            const [jana, petr] = await db()
                .insert(people)
                .values([
                    { userId: OWNER, displayName: encryptText("Jana") },
                    { userId: OWNER, displayName: encryptText("Petr") },
                ])
                .returning({ id: people.id });
            await db()
                .insert(transcriptSpeakers)
                .values(
                    [
                        ["speaker_0", jana?.id],
                        ["speaker_1", petr?.id],
                    ].map(([label, personId]) => ({
                        userId: OWNER,
                        transcriptionId: row?.id ?? "",
                        label: label ?? "",
                        personId,
                        source: "user" as const,
                        status: "confirmed" as const,
                        confirmedByUserId: OWNER,
                    })),
                );
            return {
                transcriptionId: row?.id ?? "",
                jana: jana?.id ?? "",
                petr: petr?.id ?? "",
            };
        }

        async function share() {
            const [root] = await db()
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, orgUserId));
            await addRecordingToFolder({
                userId: OWNER,
                recordingId: REC,
                folderId: root?.id ?? "",
            });
        }

        async function byLabel(transcriptionId: string) {
            return Object.fromEntries(
                (
                    await db()
                        .select({
                            label: transcriptSpeakers.label,
                            personId: transcriptSpeakers.personId,
                            markedUnknown: transcriptSpeakers.markedUnknown,
                            confirmedByUserId:
                                transcriptSpeakers.confirmedByUserId,
                        })
                        .from(transcriptSpeakers)
                        .where(
                            eq(
                                transcriptSpeakers.transcriptionId,
                                transcriptionId,
                            ),
                        )
                ).map((row) => [
                    row.label,
                    {
                        name: row.markedUnknown ? "unknown" : row.personId,
                        by: row.confirmedByUserId,
                    },
                ]),
            );
        }

        async function orgPeopleNamed(displayName: string) {
            const rows = await db()
                .select({ id: people.id, displayName: people.displayName })
                .from(people)
                .where(eq(people.userId, orgUserId));
            const { decryptText } = await import("@/lib/encryption/fields");
            return rows.filter(
                (row) => decryptText(row.displayName) === displayName,
            );
        }

        const firstTurns = [
            turn("speaker_0", 0, 10_000, "I am Jana."),
            turn("speaker_1", 10_000, 20_000, "I am Petr."),
        ];

        it("lands the organization account's change on the owner's transcript, with Organization people", async () => {
            const named = await namedTranscript();
            await share();
            const seen = await shownVersion(orgUserId);
            expect(seen.transcriptionId).toBe(named.transcriptionId);

            expect(
                (
                    await put(orgUserId, seen, {
                        label: "speaker_0",
                        displayName: "Karel",
                    })
                ).status,
            ).toBe(200);

            const [karel] = await orgPeopleNamed("Karel");
            expect(karel).toBeDefined();
            expect(await byLabel(named.transcriptionId)).toEqual({
                speaker_0: { name: karel?.id, by: orgUserId },
                speaker_1: { name: named.petr, by: OWNER },
            });
            // One recording: nothing was written anywhere else.
            const rows = await db()
                .select({ userId: transcriptions.userId })
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, REC));
            expect(rows).toEqual([{ userId: OWNER }]);
        });

        it("refuses a change made on text the organization account re-transcribed meanwhile", async () => {
            const named = await namedTranscript();
            await share();
            const seen = await shownVersion(orgUserId);

            // Its own re-transcription commits after the route checked
            // what the tab saw.
            hooks.beforeChange = async () => {
                const result = await upsertTranscription({
                    userId: OWNER,
                    actorUserId: orgUserId,
                    recordingId: REC,
                    text: "speaker_0: I am Petr.\nspeaker_1: I am Jana.",
                    detectedLanguage: null,
                    source: "riffado",
                    provider: "elevenlabs",
                    model: MODEL,
                    allowReaped: true,
                });
                expect(result.committed).toBe(true);
            };

            const response = await put(orgUserId, seen, {
                label: "speaker_0",
                displayName: "Karel",
            });
            expect(response.status).toBe(409);
            // The refused change created nobody.
            expect(await orgPeopleNamed("Karel")).toEqual([]);

            // Reloaded, the tab shows the new revision and can change it.
            const reloaded = await shownVersion(orgUserId);
            expect(reloaded).toEqual({
                transcriptionId: named.transcriptionId,
                revision: seen.revision + 1,
            });
            expect(
                (
                    await put(orgUserId, reloaded, {
                        label: "speaker_0",
                        unknown: true,
                    })
                ).status,
            ).toBe(200);
        });

        it("refuses members, and the owner until they withdraw it", async () => {
            const named = await namedTranscript();
            await share();

            const member = await put(BOB, await shownVersion(BOB), {
                label: "speaker_0",
                displayName: "Karel",
            });
            expect(member.status).toBe(403);

            const ownerSeen = await shownVersion(OWNER, "private");
            const owner = await put(
                OWNER,
                ownerSeen,
                { label: "speaker_0", unknown: true },
                "private",
            );
            expect(owner.status).toBe(409);
            await expect(owner.json()).resolves.toMatchObject({
                code: "RECORDING_SHARED",
            });
            expect(await orgPeopleNamed("Karel")).toEqual([]);
            expect(await byLabel(named.transcriptionId)).toEqual({
                speaker_0: { name: named.jana, by: OWNER },
                speaker_1: { name: named.petr, by: OWNER },
            });
        });

        it("refuses the owner's change the share committed under, whoever waited", async () => {
            const named = await namedTranscript();
            const seen = await shownVersion(OWNER, "private");
            // Shared after the route let the owner through.
            hooks.beforeChange = share;

            const response = await put(
                OWNER,
                seen,
                { label: "speaker_0", unknown: true },
                "private",
            );

            expect(response.status).toBe(409);
            expect(await byLabel(named.transcriptionId)).toMatchObject({
                speaker_0: { name: named.jana },
            });
        });

        it("gives it back as the Organization left it: the owner changes it, the organization account no longer", async () => {
            const named = await namedTranscript();
            await share();
            const seen = await shownVersion(orgUserId);
            await put(orgUserId, seen, {
                label: "speaker_1",
                unknown: true,
            });

            // Withdrawn after the organization account opened the view.
            hooks.beforeChange = () =>
                unshareRecording(OWNER, REC, { withdraw: true });
            const late = await put(orgUserId, seen, {
                label: "speaker_0",
                unknown: true,
            });
            expect(late.status).toBe(404);

            expect(await byLabel(named.transcriptionId)).toEqual({
                speaker_0: { name: named.jana, by: OWNER },
                speaker_1: { name: "unknown", by: orgUserId },
            });
            const ownerSeen = await shownVersion(OWNER, "private");
            expect(
                (
                    await put(
                        OWNER,
                        ownerSeen,
                        { label: "speaker_1", personId: named.petr },
                        "private",
                    )
                ).status,
            ).toBe(200);
        });
    },
);
