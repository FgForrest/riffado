/**
 * Who may call which recording route, in which view, against a real database.
 *
 * The access rules live in one gate (`src/lib/sharing/access.ts`), but a route
 * that forgets to call it -- or calls it with the wrong view -- is exactly
 * the failure a unit test of the gate cannot see. So this drives the routes
 * themselves as the owner, another member, the organization account, and an
 * outsider, before and after the recording is shared.
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
    asyncJobs,
    people,
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
            WHISPER_REQUEST_TIMEOUT_MS: 60_000,
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
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("audio-bytes")),
        deleteFile: vi.fn().mockResolvedValue(undefined),
    }),
}));
// Sessions come from a test header; the gate being tested sits behind it.
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

import { GET as getJob } from "@/app/api/jobs/[id]/route";
import { GET as getAudio } from "@/app/api/recordings/[id]/audio/route";
import { POST as erase } from "@/app/api/recordings/[id]/erase/route";
import {
    DELETE as leaveFolder,
    PATCH as moveBetweenFolders,
} from "@/app/api/recordings/[id]/folders/route";
import { GET as getMarkdown } from "@/app/api/recordings/[id]/markdown/[kind]/route";
import { POST as postPeaks } from "@/app/api/recordings/[id]/peaks/route";
import {
    DELETE as deleteRecording,
    PATCH as renameRecording,
} from "@/app/api/recordings/[id]/route";
import {
    GET as getSpeakers,
    PUT as putSpeaker,
} from "@/app/api/recordings/[id]/speakers/route";
import {
    DELETE as deleteSummary,
    GET as getSummary,
} from "@/app/api/recordings/[id]/summary/route";
import {
    GET as getTranscribe,
    POST as postTranscribe,
} from "@/app/api/recordings/[id]/transcribe/route";
import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, createFolder } from "@/lib/folders/folders";
import { ensureOrgAccount } from "@/lib/org/account";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const MEMBER = "user-member";
const REC = "rec-shared";

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
    const { params = { id: REC }, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("x-test-user", user);
    return (handler as Handler)(
        new Request(`http://localhost${path}`, { ...rest, headers }),
        { params: Promise.resolve(params) },
    );
}

function json(body: unknown): RequestInit {
    return {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    };
}

describeWithDatabase("recording routes by role (PostgreSQL)", () => {
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
            "route_access",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(asyncJobs);
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
        await db()
            .insert(recordings)
            .values({
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
        await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: OWNER,
                text: encryptText("speaker_0: Hello.\nspeaker_1: Hi."),
                provider: "openai",
                model: "whisper-1",
                source: "riffado",
            });
    });

    async function share() {
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: orgRootId,
        });
    }

    describe("before sharing", () => {
        it("is invisible to everyone but the owner, in every view", async () => {
            for (const user of [MEMBER, orgUserId]) {
                expect(
                    (await call(getAudio, user, `/api/recordings/${REC}/audio`))
                        .status,
                ).toBe(404);
                for (const view of ["", "?view=org"]) {
                    expect(
                        (
                            await call(
                                getSummary,
                                user,
                                `/api/recordings/${REC}/summary${view}`,
                            )
                        ).status,
                    ).toBe(404);
                    expect(
                        (
                            await call(
                                postTranscribe,
                                user,
                                `/api/recordings/${REC}/transcribe${view}`,
                                { method: "POST" },
                            )
                        ).status,
                    ).toBe(404);
                }
            }
            const jobs = await db().select().from(asyncJobs);
            expect(jobs).toHaveLength(0);
        });

        it("has no Organization view even for its owner", async () => {
            expect(
                (
                    await call(
                        getSummary,
                        OWNER,
                        `/api/recordings/${REC}/summary?view=org`,
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(
                        getSummary,
                        OWNER,
                        `/api/recordings/${REC}/summary`,
                    )
                ).status,
            ).toBe(200);
        });
    });

    describe("after sharing", () => {
        beforeEach(share);

        it("opens the audio and the Organization view to every account", async () => {
            for (const user of [OWNER, MEMBER, orgUserId]) {
                const audio = await call(
                    getAudio,
                    user,
                    `/api/recordings/${REC}/audio`,
                );
                expect(audio.status).toBe(200);
                const summary = await call(
                    getSummary,
                    user,
                    `/api/recordings/${REC}/summary?view=org`,
                );
                expect(summary.status).toBe(200);
                const markdown = await call(
                    getMarkdown,
                    user,
                    `/api/recordings/${REC}/markdown/transcript?view=org`,
                    { params: { id: REC, kind: "transcript" } },
                );
                expect(markdown.status).toBe(200);
                expect(await markdown.text()).toContain("Hello.");
            }
        });

        it("keeps the private view the owner's alone", async () => {
            for (const user of [MEMBER, orgUserId]) {
                expect(
                    (
                        await call(
                            getSummary,
                            user,
                            `/api/recordings/${REC}/summary`,
                        )
                    ).status,
                ).toBe(404);
                expect(
                    (
                        await call(
                            postTranscribe,
                            user,
                            `/api/recordings/${REC}/transcribe`,
                            { method: "POST" },
                        )
                    ).status,
                ).toBe(404);
                expect(
                    (
                        await call(
                            getSpeakers,
                            user,
                            `/api/recordings/${REC}/speakers`,
                        )
                    ).status,
                ).toBe(404);
            }
        });

        it("keeps owner-only actions away from members", async () => {
            expect(
                (
                    await call(
                        renameRecording,
                        MEMBER,
                        `/api/recordings/${REC}`,
                        { method: "PATCH", ...json({ filename: "Mine now" }) },
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(erase, MEMBER, `/api/recordings/${REC}/erase`, {
                        method: "POST",
                        ...json({ scope: "transcript" }),
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(
                        leaveFolder,
                        MEMBER,
                        `/api/recordings/${REC}/folders`,
                        { method: "DELETE", ...json({ organization: true }) },
                    )
                ).status,
            ).toBe(403);
            expect(
                (
                    await call(
                        deleteRecording,
                        MEMBER,
                        `/api/recordings/${REC}`,
                        { method: "DELETE" },
                    )
                ).status,
            ).toBe(404);
            const [still] = await db()
                .select()
                .from(recordings)
                .where(eq(recordings.id, REC));
            expect(still?.deletedAt).toBeNull();
        });

        it("names Organization speakers only with Organization people", async () => {
            const speakers = await call(
                getSpeakers,
                MEMBER,
                `/api/recordings/${REC}/speakers?view=org`,
            );
            expect(speakers.status).toBe(200);
            await expect(speakers.json()).resolves.toMatchObject({
                fallback: true,
            });
            const [privatePerson] = await db()
                .insert(people)
                .values({ userId: MEMBER, displayName: encryptText("Mine") })
                .returning({ id: people.id });
            expect(
                (
                    await call(
                        putSpeaker,
                        MEMBER,
                        `/api/recordings/${REC}/speakers?view=org`,
                        {
                            method: "PUT",
                            ...json({
                                label: "speaker_0",
                                personId: privatePerson?.id,
                            }),
                        },
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(
                        putSpeaker,
                        MEMBER,
                        `/api/recordings/${REC}/speakers?view=org`,
                        {
                            method: "PUT",
                            ...json({ label: "speaker_0", displayName: "Eva" }),
                        },
                    )
                ).status,
            ).toBe(200);
        });

        it("queues Organization work as the member and lets every viewer follow it", async () => {
            const queued = await call(
                postTranscribe,
                MEMBER,
                `/api/recordings/${REC}/transcribe?view=org`,
                { method: "POST" },
            );
            expect(queued.status).toBe(202);
            const { jobId } = (await queued.json()) as { jobId: string };
            const [job] = await db()
                .select()
                .from(asyncJobs)
                .where(eq(asyncJobs.id, jobId));
            expect(job?.userId).toBe(MEMBER);
            expect(job?.subjectId).toBe(`org:${REC}`);
            expect(job?.payload).toMatchObject({ view: "org" });

            const owner = await call(
                getTranscribe,
                OWNER,
                `/api/recordings/${REC}/transcribe?view=org`,
            );
            await expect(owner.json()).resolves.toEqual({
                activeJob: { jobId, status: "pending" },
            });
            const followed = await call(getJob, OWNER, `/api/jobs/${jobId}`, {
                params: { id: jobId },
            });
            expect(followed.status).toBe(200);
            // The owner's private view has its own job slot.
            const privateView = await call(
                getTranscribe,
                OWNER,
                `/api/recordings/${REC}/transcribe`,
            );
            await expect(privateView.json()).resolves.toEqual({});
        });

        it("lets members move but not withdraw, and lets the owner withdraw", async () => {
            const sales = await createFolder({
                userId: MEMBER,
                parentId: orgRootId,
                name: "Sales",
            });
            expect(
                (
                    await call(
                        moveBetweenFolders,
                        MEMBER,
                        `/api/recordings/${REC}/folders`,
                        {
                            method: "PATCH",
                            ...json({
                                fromFolderId: orgRootId,
                                toFolderId: sales.id,
                            }),
                        },
                    )
                ).status,
            ).toBe(200);
            expect(
                (
                    await call(
                        leaveFolder,
                        OWNER,
                        `/api/recordings/${REC}/folders`,
                        { method: "DELETE", ...json({ organization: true }) },
                    )
                ).status,
            ).toBe(200);
            expect(
                (
                    await call(
                        getSummary,
                        MEMBER,
                        `/api/recordings/${REC}/summary?view=org`,
                    )
                ).status,
            ).toBe(404);
        });

        it("takes client waveforms only from the owner and keeps the org account out of private speakers", async () => {
            const peaks = Array.from({ length: 64 }, () => 0.5);
            expect(
                (
                    await call(
                        postPeaks,
                        MEMBER,
                        `/api/recordings/${REC}/peaks`,
                        { method: "POST", ...json({ peaks }) },
                    )
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(
                        getSpeakers,
                        orgUserId,
                        `/api/recordings/${REC}/speakers`,
                    )
                ).status,
            ).toBe(404);
        });

        it("cancels queued work for both views when the recording is deleted", async () => {
            await db()
                .insert(asyncJobs)
                .values([
                    {
                        userId: MEMBER,
                        kind: "summary",
                        subjectId: `org:${REC}`,
                        payload: { recordingId: REC, view: "org" },
                    },
                    {
                        userId: OWNER,
                        kind: "transcription",
                        subjectId: REC,
                        payload: { recordingId: REC, trigger: "manual" },
                    },
                ]);
            await call(deleteRecording, OWNER, `/api/recordings/${REC}`, {
                method: "DELETE",
            });
            const jobs = await db().select().from(asyncJobs);
            expect(jobs.map((job) => job.status)).toEqual(["failed", "failed"]);
        });

        it("removes the Organization view with the recording", async () => {
            await db()
                .insert(transcriptions)
                .values({
                    recordingId: REC,
                    userId: orgUserId,
                    text: encryptText("org copy"),
                    provider: "openai",
                    model: "whisper-1",
                    source: "riffado",
                });
            expect(
                (
                    await call(
                        deleteRecording,
                        OWNER,
                        `/api/recordings/${REC}`,
                        { method: "DELETE" },
                    )
                ).status,
            ).toBe(200);
            const rows = await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, REC));
            expect(rows).toHaveLength(0);
            expect(
                (await call(getAudio, MEMBER, `/api/recordings/${REC}/audio`))
                    .status,
            ).toBe(404);
        });

        it("lets anyone clear the Organization summary but never the owner's", async () => {
            const response = await call(
                deleteSummary,
                MEMBER,
                `/api/recordings/${REC}/summary?view=org`,
                { method: "DELETE" },
            );
            expect(response.status).toBe(200);
            expect(
                (
                    await call(
                        deleteSummary,
                        MEMBER,
                        `/api/recordings/${REC}/summary`,
                        { method: "DELETE" },
                    )
                ).status,
            ).toBe(404);
        });
    });
});
