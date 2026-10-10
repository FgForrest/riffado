/**
 * Learn runs against a real PostgreSQL: what happens to them when their
 * transcript is rewritten, and when their recording leaves the
 * Organization.
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
    apiCredentials,
    asyncJobs,
    knowledgeAliases,
    learnDismissals,
    learnReviewItems,
    learnRuns,
    recordingFolderAssignments,
    recordingFolders,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
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
            AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 20,
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

const { createCompletion } = vi.hoisted(() => ({
    createCompletion: vi.fn(),
}));
vi.mock("openai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("openai")>();
    return {
        ...actual,
        OpenAI: class {
            chat = { completions: { create: createCompletion } };
        },
    };
});

// Runs once, just before the next read of the vocabulary: in the handler,
// the one that builds the final frame, after the knowledge view was read.
const { beforeVocabulary } = vi.hoisted(() => ({
    beforeVocabulary: { current: null as null | (() => Promise<void>) },
}));
vi.mock("@/lib/knowledge/vocabulary", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@/lib/knowledge/vocabulary")>();
    return {
        ...actual,
        vocabularyVisibleTo: async (
            ...args: Parameters<typeof actual.vocabularyVisibleTo>
        ) => {
            const hook = beforeVocabulary.current;
            beforeVocabulary.current = null;
            if (hook) await hook();
            return actual.vocabularyVisibleTo(...args);
        },
    };
});

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        deleteFile: vi.fn().mockResolvedValue(undefined),
    }),
}));

// Runs once, right after a request was authorized: a change landing there.
const { afterAuthorize } = vi.hoisted(() => ({
    afterAuthorize: { current: null as null | (() => Promise<void>) },
}));
vi.mock("@/lib/sharing/access", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@/lib/sharing/access")>();
    return {
        ...actual,
        requireRecordingView: async (
            ...args: Parameters<typeof actual.requireRecordingView>
        ) => {
            const access = await actual.requireRecordingView(...args);
            const hook = afterAuthorize.current;
            afterAuthorize.current = null;
            if (hook) await hook();
            return access;
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

import { GET as getPending } from "@/app/api/learn/pending/route";
import { DELETE as deleteCorrectionRoute } from "@/app/api/recordings/[id]/corrections/[correctionId]/route";
import { GET as getCorrectionsRoute } from "@/app/api/recordings/[id]/corrections/route";
import { POST as shareRoute } from "@/app/api/recordings/[id]/folders/route";
import {
    GET as getLearnRoute,
    POST as postLearnRoute,
} from "@/app/api/recordings/[id]/learn/route";
import { GET as getMarkdownRoute } from "@/app/api/recordings/[id]/markdown/[kind]/route";
import { POST as postFinishRoute } from "@/app/api/recordings/[id]/review/finish/route";
import { PATCH as patchItemRoute } from "@/app/api/recordings/[id]/review/items/[itemId]/route";
import { GET as getReviewRoute } from "@/app/api/recordings/[id]/review/route";
import { DELETE as deleteRecordingRoute } from "@/app/api/recordings/[id]/route";
import { GET as getSummaryRoute } from "@/app/api/recordings/[id]/summary/route";
import { encrypt } from "@/lib/encryption";
import {
    decryptJsonField,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import { getRecordingMarkdownDocument } from "@/lib/export/document-sidecars";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { acceptCorrection } from "@/lib/knowledge/corrections";
import { createEntity, deleteEntity } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { createPerson } from "@/lib/knowledge/people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import {
    bumpVocabularyVersionInTx,
    createPrivateType,
    seedCoreVocabulary,
} from "@/lib/knowledge/vocabulary";
import {
    learnFingerprintHmac,
    learnJobHandler,
} from "@/lib/learn/learn-job-handler";
import { llmRendering } from "@/lib/learn/llm-input";
import {
    pendingReviewCount,
    recordingsNeedingReview,
    reviewQueue,
} from "@/lib/learn/pending";
import { finishReview } from "@/lib/learn/review";
import { newRecordFingerprint } from "@/lib/learn/validate-new-records";
import { ensureOrgAccount } from "@/lib/org/account";
import { requireRecordingView } from "@/lib/sharing/access";
import type { StorageProvider } from "@/lib/storage/types";
import { generateSummaryForRecording } from "@/lib/summary/generate-summary";
import { upsertTranscription } from "@/lib/transcription/persist";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const BOB = "user-bob";
const REC = "rec-learn";
const TURNS: TranscriptTurn[] = [
    { speaker: "speaker_0", startMs: 0, endMs: 5_000, text: "Dobrý den." },
];

describeWithDatabase("Learn runs (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let transcriptId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "learn_runs",
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
                { id: OWNER, email: "o@example.test" },
                { id: BOB, email: "b@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await insertRecordings(db(), {
            id: REC,
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 5_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:05Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/rec.mp3`,
            plaudVersion: "1",
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: OWNER,
                text: encryptText(TURNS[0]?.text ?? ""),
                turns: encryptJsonField(TURNS),
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        transcriptId = transcript?.id ?? "";
        await db().insert(transcriptSpeakers).values({
            userId: OWNER,
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: null,
            source: "user",
            status: "confirmed",
            markedUnknown: true,
            confirmedByUserId: OWNER,
        });
    });

    function run(
        view: "private" | "org",
        status: "queued" | "running" | "ready" | "finished",
    ) {
        return db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: view === "org" ? orgUserId : OWNER,
                itemId: REC,
                transcriptionId: transcriptId,
                view,
                actorUserId: view === "org" ? orgUserId : OWNER,
                trigger: "manual",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status,
            })
            .returning({ id: learnRuns.id })
            .then((rows) => rows[0]?.id ?? "");
    }

    const statusOf = async (id: string) =>
        (
            await db()
                .select({ status: learnRuns.status })
                .from(learnRuns)
                .where(eq(learnRuns.id, id))
        )[0]?.status;

    it("supersedes the pending runs of a transcript that is rewritten, and leaves finished ones", async () => {
        const queued = await run("private", "queued");
        const ready = await run("private", "ready");
        const finished = await run("private", "finished");

        await upsertTranscription({
            userId: OWNER,
            recordingId: REC,
            text: "Dobrý den všem.",
            detectedLanguage: "cs",
            source: "riffado",
            provider: "openai",
            model: "gpt-4o-transcribe-diarize",
            turns: [
                { ...(TURNS[0] as TranscriptTurn), text: "Dobrý den všem." },
            ],
        });

        expect(await statusOf(queued)).toBe("superseded");
        expect(await statusOf(ready)).toBe("superseded");
        expect(await statusOf(finished)).toBe("finished");
    });

    it("takes the Organization's dismissals with the recording even when no transcript is left", async () => {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: root?.id ?? "",
        });
        await db().insert(learnDismissals).values({
            userId: orgUserId,
            itemId: REC,
            fingerprintHmac: "f",
        });
        await db().delete(transcriptions);

        await unshareRecording(OWNER, REC, { withdraw: true });

        expect(await db().select().from(learnDismissals)).toEqual([]);
    });

    it("takes every dismissal with a deleted recording, whose tombstone stays", async () => {
        await db()
            .insert(learnDismissals)
            .values([
                { userId: OWNER, itemId: REC, fingerprintHmac: "a" },
                { userId: orgUserId, itemId: REC, fingerprintHmac: "b" },
            ]);
        const deleted = await deleteRecordingRoute(
            new Request(`http://localhost/api/recordings/${REC}`, {
                method: "DELETE",
                headers: { "x-test-user": OWNER },
            }),
            { params: Promise.resolve({ id: REC }) },
        );
        expect(deleted.status).toBe(200);
        expect(await db().select().from(learnDismissals)).toEqual([]);
    });

    it("takes the Organization's runs, and what they proposed, with the recording when it leaves", async () => {
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: root?.id ?? "",
        });
        const orgs = await run("org", "ready");
        await db()
            .insert(learnReviewItems)
            .values({
                runId: orgs,
                userId: orgUserId,
                kind: "fact",
                fingerprintHmac: "f",
                payload: encryptJsonField({ secret: "what the curator found" }),
            });

        await unshareRecording(OWNER, REC, { withdraw: true });

        expect(await statusOf(orgs)).toBeUndefined();
        expect(await db().select().from(learnReviewItems)).toEqual([]);
    });

    function learn(
        user: string,
        {
            view,
            method = "POST",
            source,
        }: { view?: "org"; method?: string; source?: "plaud" } = {},
    ) {
        const query = new URLSearchParams({
            ...(view ? { view } : {}),
            ...(source ? { source } : {}),
        }).toString();
        const handler = method === "POST" ? postLearnRoute : getLearnRoute;
        return handler(
            new Request(
                `http://localhost/api/recordings/${REC}/learn${query ? `?${query}` : ""}`,
                { method, headers: { "x-test-user": user } },
            ),
            { params: Promise.resolve({ id: REC }) },
        );
    }

    const provider = (userId: string) =>
        db()
            .insert(apiCredentials)
            .values({
                userId,
                provider: "openai",
                apiKey: encrypt("key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });

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

    it("starts a run for its owner, with their chat provider, and joins it when asked again", async () => {
        const refused = await learn(OWNER);
        expect(refused.status).toBe(400);
        await expect(refused.json()).resolves.toMatchObject({
            code: "AI_PROVIDER_NOT_CONFIGURED",
        });

        await provider(OWNER);
        const started = await learn(OWNER);
        expect(started.status).toBe(202);
        const { runId, created } = (await started.json()) as {
            runId: string;
            created: boolean;
        };
        expect(created).toBe(true);
        const [row] = await db()
            .select()
            .from(learnRuns)
            .where(eq(learnRuns.id, runId));
        expect(row).toMatchObject({
            userId: OWNER,
            scopeUserId: OWNER,
            view: "private",
            status: "queued",
            transcriptionId: transcriptId,
        });
        const jobs = await db()
            .select({
                kind: asyncJobs.kind,
                subjectId: asyncJobs.subjectId,
                payload: asyncJobs.payload,
            })
            .from(asyncJobs);
        expect(jobs).toEqual([
            { kind: "learn.run", subjectId: REC, payload: { runId } },
        ]);

        const again = await learn(OWNER);
        await expect(again.json()).resolves.toMatchObject({
            runId,
            created: false,
        });
        const listed = await learn(OWNER, { method: "GET" });
        await expect(listed.json()).resolves.toMatchObject({
            runs: [{ id: runId, source: "riffado", status: "queued" }],
        });
        // Nobody else sees it.
        expect((await learn(BOB, { method: "GET" })).status).toBe(404);
    });

    it("refuses a transcript without timings, or one the recording does not have", async () => {
        await provider(OWNER);
        await db()
            .update(transcriptions)
            .set({
                turns: encryptJsonField([
                    { ...(TURNS[0] as TranscriptTurn), startMs: 0, endMs: 0 },
                ]),
            })
            .where(eq(transcriptions.id, transcriptId));
        expect((await learn(OWNER)).status).toBe(400);
        expect((await learn(OWNER, { source: "plaud" })).status).toBe(400);
    });

    it("treats a run whose job is gone as dead: it blocks neither a new run nor sharing", async () => {
        await provider(OWNER);
        const first = (await (await learn(OWNER)).json()) as {
            runId: string;
        };
        // What a buried job leaves: the job failed, the run still running.
        await db()
            .update(learnRuns)
            .set({ status: "running" })
            .where(eq(learnRuns.id, first.runId));
        await db()
            .update(asyncJobs)
            .set({ status: "failed", completedAt: new Date() });

        const again = (await (await learn(OWNER)).json()) as {
            runId: string;
            created: boolean;
        };
        expect(again.created).toBe(true);
        expect(again.runId).not.toBe(first.runId);
        const [dead] = await db()
            .select({ status: learnRuns.status })
            .from(learnRuns)
            .where(eq(learnRuns.id, first.runId));
        expect(dead?.status).toBe("failed");

        // Its job gone too, the new one no longer holds the share either.
        await db()
            .update(asyncJobs)
            .set({ status: "failed", completedAt: new Date() });
        await expect(share()).resolves.toBeUndefined();
    });

    it("starts afresh after a rewrite superseded a run whose job still held the slot", async () => {
        await provider(OWNER);
        const first = (await (await learn(OWNER)).json()) as {
            runId: string;
        };
        await upsertTranscription({
            userId: OWNER,
            recordingId: REC,
            text: "Dobrý den všem.",
            detectedLanguage: "cs",
            source: "riffado",
            provider: "openai",
            model: "gpt-4o-transcribe-diarize",
            turns: [
                { ...(TURNS[0] as TranscriptTurn), text: "Dobrý den všem." },
            ],
        });
        const again = (await (await learn(OWNER)).json()) as {
            runId: string;
            created: boolean;
        };
        expect(again).toMatchObject({ created: true });
        expect(again.runId).not.toBe(first.runId);
        const jobs = await db()
            .select({ status: asyncJobs.status, payload: asyncJobs.payload })
            .from(asyncJobs);
        expect(
            jobs
                .filter((job) => job.status === "pending")
                .map((job) => job.payload),
        ).toEqual([{ runId: again.runId }]);
    });

    it("keeps an owner's unfinished run from sharing, and lets only the organization account run it while shared", async () => {
        await provider(OWNER);
        await provider(orgUserId);
        await learn(OWNER);
        await expect(share()).rejects.toMatchObject({
            code: "SHARE_REQUIREMENTS_UNMET",
        });

        await db().delete(learnRuns);
        await share();
        const ownerTry = await learn(OWNER);
        expect(ownerTry.status).toBe(409);
        expect((await learn(BOB, { view: "org" })).status).toBe(403);
        const curated = await learn(orgUserId, { view: "org" });
        expect(curated.status).toBe(202);
        const [row] = await db()
            .select({
                scopeUserId: learnRuns.scopeUserId,
                view: learnRuns.view,
            })
            .from(learnRuns);
        expect(row).toEqual({ scopeUserId: orgUserId, view: "org" });
    });

    describe("running", () => {
        const reply = (content: object | string) =>
            createCompletion.mockResolvedValueOnce({
                choices: [
                    {
                        message: {
                            content:
                                typeof content === "string"
                                    ? content
                                    : JSON.stringify(content),
                        },
                    },
                ],
            });
        const runJob = (runId: string) =>
            learnJobHandler.run({
                payload: { runId },
                userId: OWNER,
                jobId: "job",
                attempt: 1,
                maxAttempts: 2,
                signal: new AbortController().signal,
                reportProgress: () => {},
            });
        const statusAndStats = async (runId: string) =>
            (
                await db()
                    .select({
                        status: learnRuns.status,
                        stats: learnRuns.stats,
                    })
                    .from(learnRuns)
                    .where(eq(learnRuns.id, runId))
            )[0];

        beforeEach(async () => {
            createCompletion.mockReset();
            knowledgeStore().invalidateAll();
            await seedCoreVocabulary();
            await provider(OWNER);
            await db()
                .update(transcriptions)
                .set({
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 5_000,
                            text: "Dobrý den, máme tu Tavesy.",
                        },
                    ]),
                })
                .where(eq(transcriptions.id, transcriptId));
        });

        it("takes the bridge path for a bridge provider: one call, this run's token and the schema, validated the same", async () => {
            const tavesi = (
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            await db()
                .update(apiCredentials)
                .set({
                    provider: "Claude Code",
                    defaultModel: "claude-opus-5-5",
                    baseUrl: "http://agent-bridge:8787/v1",
                })
                .where(eq(apiCredentials.userId, OWNER));
            (mockEnv as Record<string, unknown>).LEARN_MCP_URL =
                "http://app:3000/api/mcp/learn";
            (mockEnv as Record<string, unknown>).LEARN_BRIDGE_URL =
                "http://agent-bridge:8787/v1";
            try {
                const { runId } = (await (await learn(OWNER)).json()) as {
                    runId: string;
                };
                reply({
                    speakers: [],
                    corrections: [
                        {
                            turnIndex: 0,
                            charStart: 0,
                            charEnd: 1,
                            heard: "Tavesy",
                            kind: "correct",
                            target: { entityId: tavesi },
                            replacement: "Tavesi",
                        },
                    ],
                    facts: [],
                    relationPhrases: [],
                });

                await expect(runJob(runId)).resolves.toMatchObject({
                    status: "ready",
                    items: 1,
                });
                expect(createCompletion).toHaveBeenCalledTimes(1);
                const body = createCompletion.mock.calls[0]?.[0] as {
                    model: string;
                    response_format: { type: string };
                    riffado_mcp: { token: string; tools: string[] };
                };
                expect(body.model).toBe("claude-opus-5-5");
                expect(body.response_format.type).toBe("json_schema");
                expect(body.riffado_mcp.tools).toEqual([
                    "find_entities",
                    "get_entity",
                    "find_facts",
                ]);
                expect(body.riffado_mcp.token).toMatch(
                    new RegExp(`^lr1\\.${runId}\\.`),
                );
            } finally {
                (mockEnv as Record<string, unknown>).LEARN_MCP_URL = undefined;
                (mockEnv as Record<string, unknown>).LEARN_BRIDGE_URL =
                    undefined;
            }
        });

        it("stores what holds as review items, encrypted, and is ready for review", async () => {
            const tavesi = (
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            const started = await learn(OWNER);
            const { runId } = (await started.json()) as { runId: string };
            reply({ mentions: [{ text: "Tavesy", turn: 0 }] });
            reply({
                speakers: [],
                corrections: [
                    {
                        turnIndex: 0,
                        charStart: 0,
                        charEnd: 1,
                        heard: "Tavesy",
                        kind: "correct",
                        target: { entityId: tavesi },
                        replacement: "Tavesi",
                    },
                    {
                        turnIndex: 0,
                        charStart: 0,
                        charEnd: 5,
                        heard: "Dobrý",
                        kind: "correct",
                        target: { entityId: "someone-elses" },
                        replacement: "x",
                    },
                ],
                facts: [],
                relationPhrases: [],
            });

            await expect(runJob(runId)).resolves.toMatchObject({
                status: "ready",
                items: 1,
            });
            expect(await statusAndStats(runId)).toMatchObject({
                status: "ready",
                stats: expect.objectContaining({
                    items_correction: 1,
                    dropped_outOfScope: 1,
                }),
            });
            const [item] = await db().select().from(learnReviewItems);
            expect(item).toMatchObject({
                runId,
                userId: OWNER,
                kind: "correction",
                preTicked: false,
            });
            expect(JSON.stringify(item?.payload)).not.toContain("Tavesi");
            expect(
                decryptJsonField<{ anchors: unknown[] }>(item?.payload)
                    ?.anchors,
            ).toEqual([{ turnIndex: 0, charStart: 19, charEnd: 25 }]);
        });

        it("tells the model who made the recording, and names them on their role", async () => {
            // Their own record, carrying the account's email.
            const me = await createPerson({
                userId: OWNER,
                displayName: "Jan Novák",
                primaryEmail: "O@example.test",
            });
            await db()
                .update(transcriptions)
                .set({
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 5_000,
                            text: "Dobrý den, máme tu Tavesy.",
                        },
                        {
                            speaker: "speaker_1",
                            startMs: 5_000,
                            endMs: 9_000,
                            text: "Tak začneme.",
                        },
                    ]),
                })
                .where(eq(transcriptions.id, transcriptId));
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            reply({ mentions: [] });
            reply({
                speakers: [
                    {
                        label: "speaker_1",
                        personId: me.id,
                        evidence: ["00:05"],
                        reason: "Opens the meeting.",
                    },
                ],
                corrections: [],
                facts: [],
                relationPhrases: [],
            });

            await expect(runJob(runId)).resolves.toMatchObject({
                status: "ready",
                items: 1,
            });
            const answer = createCompletion.mock.calls.at(-1)?.[0] as {
                messages: { role: string; content: string }[];
            };
            expect(answer.messages[0]?.content).toContain("recorder");
            expect(answer.messages[1]?.content).toContain(
                JSON.stringify({ personId: me.id, name: "Jan Novák" }),
            );
            const [item] = await db().select().from(learnReviewItems);
            expect(decryptJsonField(item?.payload)).toMatchObject({
                label: "speaker_1",
                personId: me.id,
                recorder: true,
            });
        });

        it("proposes a new thing it heard, and not one rejected on another recording", async () => {
            await db()
                .update(transcriptions)
                .set({
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 5_000,
                            text: "Dobrý den, pro firmu Veltrix chystáme Lumenku.",
                        },
                    ]),
                })
                .where(eq(transcriptions.id, transcriptId));
            const answer = {
                newRecords: [
                    {
                        ref: "n1",
                        kind: "entity",
                        typeKey: "organization",
                        name: "Veltrix",
                        speakerLabel: null,
                        evidence: ["00:00"],
                        reason: "the client",
                    },
                    {
                        ref: "n2",
                        kind: "entity",
                        typeKey: "project",
                        name: "Lumenka",
                        speakerLabel: null,
                        evidence: ["00:00"],
                        reason: "the project",
                    },
                ],
                speakers: [],
                corrections: [],
                facts: [],
                relationPhrases: [],
            };
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            reply({ mentions: [{ text: "Veltrix", turn: 0 }] });
            reply(answer);
            await expect(runJob(runId)).resolves.toMatchObject({
                status: "ready",
                items: 2,
            });
            expect(await statusAndStats(runId)).toMatchObject({
                stats: expect.objectContaining({ items_new_record: 2 }),
            });
            const prompt = JSON.stringify(createCompletion.mock.calls[1]?.[0]);
            expect(prompt).toContain("newRecords");
            expect(prompt).toContain('\\"notFound\\":[\\"Veltrix\\"]');

            // Veltrix rejected on another recording of the owner's.
            await insertRecordings(db(), {
                id: "rec-other",
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: "plaud-2",
                filename: encryptText("Other"),
                duration: 5_000,
                startTime: new Date("2026-09-02T10:00:00Z"),
                endTime: new Date("2026-09-02T10:00:05Z"),
                filesize: 11,
                fileMd5: "1".repeat(32),
                storageType: "local",
                storagePath: `${OWNER}/other.mp3`,
                plaudVersion: "1",
            });
            await db()
                .insert(learnDismissals)
                .values({
                    userId: OWNER,
                    itemId: "rec-other",
                    fingerprintHmac: learnFingerprintHmac(
                        newRecordFingerprint(
                            "entity",
                            "organization",
                            "Veltrix",
                        ),
                    ),
                    scopeWide: true,
                });
            await db().delete(learnRuns);
            const again = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            reply({ mentions: [] });
            reply(answer);
            await expect(runJob(again.runId)).resolves.toMatchObject({
                status: "ready",
                items: 1,
            });
            const items = await db().select().from(learnReviewItems);
            expect(
                items.map(
                    (item) =>
                        decryptJsonField<{ name: string }>(item.payload)?.name,
                ),
            ).toEqual(["Lumenka"]);
        });

        it("validates again when knowledge changed after it validated, and keeps what the tools counted", async () => {
            const tavesi = (
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            reply({ mentions: [{ text: "Tavesy", turn: 0 }] });
            createCompletion.mockImplementationOnce(async () => {
                // What the MCP route counts on the run meanwhile.
                await db()
                    .update(learnRuns)
                    .set({ stats: { tool_calls: 3 } })
                    .where(eq(learnRuns.id, runId));
                // Deleted after the final frame read the knowledge, before
                // the items are written.
                beforeVocabulary.current = () => deleteEntity(OWNER, tavesi);
                return {
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    speakers: [],
                                    corrections: [
                                        {
                                            turnIndex: 0,
                                            charStart: 19,
                                            charEnd: 25,
                                            heard: "Tavesy",
                                            kind: "correct",
                                            target: { entityId: tavesi },
                                            replacement: "Tavesi",
                                        },
                                    ],
                                    facts: [],
                                    relationPhrases: [],
                                }),
                            },
                        },
                    ],
                };
            });

            await expect(runJob(runId)).resolves.toMatchObject({
                status: "finished",
                items: 0,
            });
            expect(await db().select().from(learnReviewItems)).toEqual([]);
            expect((await statusAndStats(runId))?.stats).toMatchObject({
                tool_calls: 3,
                fence_retries: 1,
                dropped_outOfScope: 1,
            });
        });

        it("waits for a change about to commit before it writes, and validates again", async () => {
            const tavesi = (
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            let writer: Promise<unknown> = Promise.resolve();
            reply({ mentions: [{ text: "Tavesy", turn: 0 }] });
            createCompletion.mockImplementationOnce(async () => {
                // A change that has bumped its scope, and commits only
                // after the run's final transaction read the generations.
                beforeVocabulary.current = async () => {
                    let bumped = () => {};
                    const didBump = new Promise<void>((resolve) => {
                        bumped = resolve;
                    });
                    writer = db().transaction(async (tx) => {
                        await bumpScopeInTx(tx, [OWNER]);
                        bumped();
                        await new Promise((resolve) =>
                            setTimeout(resolve, 300),
                        );
                    });
                    await didBump;
                };
                return {
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    speakers: [],
                                    corrections: [
                                        {
                                            turnIndex: 0,
                                            charStart: 19,
                                            charEnd: 25,
                                            heard: "Tavesy",
                                            kind: "correct",
                                            target: { entityId: tavesi },
                                            replacement: "Tavesi",
                                        },
                                    ],
                                    facts: [],
                                    relationPhrases: [],
                                }),
                            },
                        },
                    ],
                };
            });
            await runJob(runId);
            await writer;
            expect((await statusAndStats(runId))?.stats).toMatchObject({
                fence_retries: 1,
            });
        });

        it("takes the vocabulary before the scopes, as writers do, so a type changing meanwhile deadlocks nothing", async () => {
            const tavesi = (
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            let writer: Promise<unknown> = Promise.resolve();
            reply({ mentions: [{ text: "Tavesy", turn: 0 }] });
            createCompletion.mockImplementationOnce(async () => {
                beforeVocabulary.current = async () => {
                    let bumped = () => {};
                    const didBump = new Promise<void>((resolve) => {
                        bumped = resolve;
                    });
                    // A type created, renamed or deleted: the vocabulary's
                    // version first, the scope generations last.
                    writer = db().transaction(async (tx) => {
                        await bumpVocabularyVersionInTx(tx);
                        bumped();
                        await new Promise((resolve) =>
                            setTimeout(resolve, 400),
                        );
                        await bumpScopeInTx(tx, [OWNER]);
                    });
                    await didBump;
                };
                return {
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    speakers: [],
                                    corrections: [
                                        {
                                            turnIndex: 0,
                                            charStart: 19,
                                            charEnd: 25,
                                            heard: "Tavesy",
                                            kind: "correct",
                                            target: { entityId: tavesi },
                                            replacement: "Tavesi",
                                        },
                                    ],
                                    facts: [],
                                    relationPhrases: [],
                                }),
                            },
                        },
                    ],
                };
            });
            await expect(runJob(runId)).resolves.toMatchObject({
                status: "ready",
            });
            await expect(writer).resolves.toBeUndefined();
            expect((await statusAndStats(runId))?.stats).toMatchObject({
                fence_retries: 1,
            });
        }, 30_000);

        it("pre-ticks a heard form only where the person's correction wrote the name itself", async () => {
            const tavesi = (
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            await db()
                .update(transcriptions)
                .set({
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 5_000,
                            text: "Máme tu Tavesy a Tavesy zase.",
                        },
                    ]),
                })
                .where(eq(transcriptions.id, transcriptId));
            const confirm = (replacement: string) =>
                acceptCorrection({
                    userId: OWNER,
                    transcriptionId: transcriptId,
                    revision: 0,
                    actorUserId: OWNER,
                    orgUserId,
                    anchor: {
                        turnIndex: 0,
                        charStart: 8,
                        charEnd: 14,
                        heard: "Tavesy",
                    },
                    kind: "correct",
                    target: { entityId: tavesi },
                    replacement,
                });
            const proposeSecond = async () => {
                const { runId } = (await (await learn(OWNER)).json()) as {
                    runId: string;
                };
                reply({ mentions: [{ text: "Tavesy", turn: 0 }] });
                reply({
                    speakers: [],
                    corrections: [
                        {
                            turnIndex: 0,
                            charStart: 17,
                            charEnd: 23,
                            heard: "Tavesy",
                            kind: "correct",
                            target: { entityId: tavesi },
                            replacement: "Tavesi",
                        },
                    ],
                    facts: [],
                    relationPhrases: [],
                });
                await runJob(runId);
                const items = await db()
                    .select({ preTicked: learnReviewItems.preTicked })
                    .from(learnReviewItems)
                    .where(eq(learnReviewItems.runId, runId));
                return items.map((item) => item.preTicked);
            };

            // Accepted in another form: nothing learned about the name.
            await confirm("Tavesiho");
            expect(await proposeSecond()).toEqual([false]);
        });

        it("does not pre-tick on an acceptance in another provider's transcripts", async () => {
            const tavesi = (
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            await db()
                .update(transcriptions)
                .set({
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 5_000,
                            text: "Máme tu Tavesy a Tavesy a Tavesy zase.",
                        },
                    ]),
                })
                .where(eq(transcriptions.id, transcriptId));
            const confirm = (charStart: number, replacement: string) =>
                acceptCorrection({
                    userId: OWNER,
                    transcriptionId: transcriptId,
                    revision: 0,
                    actorUserId: OWNER,
                    orgUserId,
                    anchor: {
                        turnIndex: 0,
                        charStart,
                        charEnd: charStart + 6,
                        heard: "Tavesy",
                    },
                    kind: "correct",
                    target: { entityId: tavesi },
                    replacement,
                });
            // Word for word, but as another provider hears it.
            await confirm(8, "Tavesi");
            await db()
                .update(knowledgeAliases)
                .set({ provider: "another-provider" })
                .where(eq(knowledgeAliases.kind, "heard_as"));
            // In this transcript's own provider, only in another form.
            await confirm(17, "Tavesiho");
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            reply({ mentions: [{ text: "Tavesy", turn: 0 }] });
            reply({
                speakers: [],
                corrections: [
                    {
                        turnIndex: 0,
                        charStart: 26,
                        charEnd: 32,
                        heard: "Tavesy",
                        kind: "correct",
                        target: { entityId: tavesi },
                        replacement: "Tavesi",
                    },
                ],
                facts: [],
                relationPhrases: [],
            });
            await runJob(runId);
            expect(
                (
                    await db()
                        .select({ preTicked: learnReviewItems.preTicked })
                        .from(learnReviewItems)
                        .where(eq(learnReviewItems.runId, runId))
                ).map((item) => item.preTicked),
            ).toEqual([false]);
        });

        it("pre-ticks the same rewrite the person accepted before", async () => {
            const tavesi = (
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            await db()
                .update(transcriptions)
                .set({
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 5_000,
                            text: "Máme tu Tavesy a Tavesy zase.",
                        },
                    ]),
                })
                .where(eq(transcriptions.id, transcriptId));
            await acceptCorrection({
                userId: OWNER,
                transcriptionId: transcriptId,
                revision: 0,
                actorUserId: OWNER,
                orgUserId,
                anchor: {
                    turnIndex: 0,
                    charStart: 8,
                    charEnd: 14,
                    heard: "Tavesy",
                },
                kind: "correct",
                target: { entityId: tavesi },
                replacement: "Tavesi",
            });
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            reply({ mentions: [{ text: "Tavesy", turn: 0 }] });
            reply({
                speakers: [],
                corrections: [
                    {
                        turnIndex: 0,
                        charStart: 17,
                        charEnd: 23,
                        heard: "Tavesy",
                        kind: "correct",
                        target: { entityId: tavesi },
                        replacement: "Tavesi",
                    },
                ],
                facts: [],
                relationPhrases: [],
            });
            await runJob(runId);
            expect(
                (
                    await db()
                        .select({ preTicked: learnReviewItems.preTicked })
                        .from(learnReviewItems)
                        .where(eq(learnReviewItems.runId, runId))
                ).map((item) => item.preTicked),
            ).toEqual([true]);
        });

        it("writes, pre-ticking nothing, when knowledge keeps moving", async () => {
            const tavesi = (
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            let made = 0;
            const again = async () => {
                made++;
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: `Busy ${made}`,
                });
                beforeVocabulary.current = again;
            };
            reply({ mentions: [{ text: "Tavesy", turn: 0 }] });
            createCompletion.mockImplementationOnce(async () => {
                beforeVocabulary.current = again;
                return {
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    speakers: [],
                                    corrections: [
                                        {
                                            turnIndex: 0,
                                            charStart: 19,
                                            charEnd: 25,
                                            heard: "Tavesy",
                                            kind: "correct",
                                            target: { entityId: tavesi },
                                            replacement: "Tavesi",
                                        },
                                    ],
                                    facts: [],
                                    relationPhrases: [],
                                }),
                            },
                        },
                    ],
                };
            });
            try {
                await expect(runJob(runId)).resolves.toMatchObject({
                    status: "ready",
                    items: 1,
                });
            } finally {
                beforeVocabulary.current = null;
            }
            expect(
                (await db().select().from(learnReviewItems)).map(
                    (item) => item.preTicked,
                ),
            ).toEqual([false]);
            expect((await statusAndStats(runId))?.stats).toMatchObject({
                fence_retries: 2,
            });
        });

        it("reads a ticked correction at every occurrence, whatever its case, as finishing applies it", async () => {
            await db()
                .update(transcriptions)
                .set({
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 5_000,
                            text: "Dobrý den, máme tu Tavesy a tavesy znovu.",
                        },
                    ]),
                })
                .where(eq(transcriptions.id, transcriptId));
            const tavesi = (
                await createEntity(OWNER, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            const correction = (charStart: number, heard: string) => ({
                turnIndex: 0,
                charStart,
                charEnd: charStart + 6,
                heard,
                kind: "correct",
                target: { entityId: tavesi },
                replacement: "Tavesi",
            });
            reply({ mentions: [{ text: "Tavesy", turn: 0 }] });
            reply({
                speakers: [],
                corrections: [
                    correction(19, "Tavesy"),
                    correction(28, "tavesy"),
                ],
                facts: [],
                relationPhrases: [],
            });
            await runJob(runId);
            const [item] = await db().select().from(learnReviewItems);
            await db()
                .update(learnReviewItems)
                .set({ decision: "accepted", version: 1 })
                .where(eq(learnReviewItems.id, item?.id ?? ""));
            const during = await llmRendering(transcriptId);
            expect(during?.text).toBe(
                "speaker_0: Dobrý den, máme tu Tavesi a Tavesi znovu.",
            );
            await finishReview(
                await requireRecordingView(OWNER, REC, "private"),
                OWNER,
                { versions: { [item?.id ?? ""]: 1 } },
            );
            expect((await llmRendering(transcriptId))?.fingerprint).toBe(
                during?.fingerprint,
            );
        });

        it("keeps the status a rewrite set while a provider call was out, when that call then fails", async () => {
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            createCompletion.mockImplementationOnce(async () => {
                // What the rewrite hook does, meanwhile.
                await db()
                    .update(learnRuns)
                    .set({ status: "superseded" })
                    .where(eq(learnRuns.id, runId));
                throw Object.assign(new Error("bad request"), { status: 400 });
            });
            await expect(runJob(runId)).rejects.toThrow();
            expect((await statusAndStats(runId))?.status).toBe("superseded");
        });

        it("finishes a run that found nothing new", async () => {
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            reply({ mentions: [] });
            reply({
                speakers: [],
                corrections: [],
                facts: [],
                relationPhrases: [],
            });
            await runJob(runId);
            expect((await statusAndStats(runId))?.status).toBe("finished");
        });

        it("is superseded when its transcript changed, and cancelled when its recording was shared since", async () => {
            const { runId } = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            await db()
                .update(transcriptions)
                .set({ revision: 5 })
                .where(eq(transcriptions.id, transcriptId));
            await runJob(runId);
            expect((await statusAndStats(runId))?.status).toBe("superseded");
            expect(createCompletion).not.toHaveBeenCalled();

            await db().delete(learnRuns);
            await db().delete(asyncJobs);
            const second = (await (await learn(OWNER)).json()) as {
                runId: string;
            };
            // Shared meanwhile (the gate would wait for the run; a share
            // from before the gate existed, or local mode switched off, would
            // not).
            const [root] = await db()
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(eq(recordingFolders.userId, orgUserId));
            await db()
                .insert(recordingFolderAssignments)
                .values({
                    userId: orgUserId,
                    itemId: REC,
                    folderId: root?.id ?? "",
                });
            await runJob(second.runId);
            expect((await statusAndStats(second.runId))?.status).toBe(
                "cancelled",
            );
            expect(createCompletion).not.toHaveBeenCalled();
        });

        describe("reviewing", () => {
            type Handler = (
                request: Request,
                context: { params: Promise<Record<string, string>> },
            ) => Promise<Response>;
            const route = (
                handler: unknown,
                user: string,
                path: string,
                {
                    method = "GET",
                    body,
                    params = {},
                }: {
                    method?: string;
                    body?: object;
                    params?: Record<string, string>;
                } = {},
            ) =>
                (handler as Handler)(
                    new Request(
                        `http://localhost/api/recordings/${REC}/${path}`,
                        {
                            method,
                            headers: {
                                "content-type": "application/json",
                                "x-test-user": user,
                            },
                            ...(body ? { body: JSON.stringify(body) } : {}),
                        },
                    ),
                    { params: Promise.resolve({ id: REC, ...params }) },
                );

            async function readyRun() {
                const tavesi = (
                    await createEntity(OWNER, {
                        typeKey: "organization",
                        name: "Tavesi",
                    })
                ).id;
                const { runId } = (await (await learn(OWNER)).json()) as {
                    runId: string;
                };
                reply({ mentions: [{ text: "Tavesy", turn: 0 }] });
                reply({
                    speakers: [],
                    corrections: [
                        {
                            turnIndex: 0,
                            charStart: 19,
                            charEnd: 25,
                            heard: "Tavesy",
                            kind: "correct",
                            target: { entityId: tavesi },
                            replacement: "Tavesi",
                        },
                    ],
                    facts: [],
                    relationPhrases: [
                        {
                            phrase: "dodává",
                            subject: { entityId: tavesi },
                            object: { literal: "senzory" },
                            start: "00:00",
                            end: "00:05",
                            sensitivity: "none",
                        },
                    ],
                });
                await runJob(runId);
                return { runId, tavesi };
            }

            it("shows its items to the owner with the names they refer to, and to nobody else", async () => {
                const { tavesi } = await readyRun();
                const review = await route(getReviewRoute, OWNER, "review");
                const body = (await review.json()) as {
                    run: { status: string };
                    items: { kind: string; preTicked: boolean }[];
                    names: Record<string, string>;
                };
                expect(body.run.status).toBe("ready");
                expect(body.items.map((item) => item.kind).sort()).toEqual([
                    "correction",
                    "relation_phrase",
                ]);
                expect(body.names).toEqual({ [tavesi]: "Tavesi" });
                expect(
                    (await route(getReviewRoute, BOB, "review")).status,
                ).toBe(404);
            });

            it("keeps drafts by version, and finishing applies what is ticked and remembers what is not", async () => {
                await readyRun();
                const { items } = (await (
                    await route(getReviewRoute, OWNER, "review")
                ).json()) as {
                    items: { id: string; kind: string; version: number }[];
                };
                const correction = items.find(
                    (item) => item.kind === "correction",
                );
                const phrase = items.find(
                    (item) => item.kind === "relation_phrase",
                );
                const patch = (id: string, body: object) =>
                    route(patchItemRoute, OWNER, `review/items/${id}`, {
                        method: "PATCH",
                        body,
                        params: { itemId: id },
                    });
                expect(
                    (
                        await patch(correction?.id ?? "", {
                            decision: "accepted",
                            version: 5,
                        })
                    ).status,
                ).toBe(409);
                const decided = await patch(correction?.id ?? "", {
                    decision: "accepted",
                    version: 0,
                });
                await expect(decided.json()).resolves.toEqual({ version: 1 });

                const finished = await route(
                    postFinishRoute,
                    OWNER,
                    "review/finish",
                    {
                        method: "POST",
                        body: {
                            versions: {
                                [correction?.id ?? ""]: 1,
                                [phrase?.id ?? ""]: 0,
                            },
                        },
                    },
                );
                await expect(finished.json()).resolves.toMatchObject({
                    status: "finished",
                    applied: 1,
                    dismissed: 1,
                    skipped: [],
                });
                const corrections = await db()
                    .select({
                        userId: transcriptCorrections.userId,
                        charStart: transcriptCorrections.charStart,
                    })
                    .from(transcriptCorrections);
                expect(corrections).toEqual([{ userId: OWNER, charStart: 19 }]);
                expect(await db().select().from(learnDismissals)).toHaveLength(
                    1,
                );
                expect(
                    (await route(getReviewRoute, OWNER, "review")).status,
                ).toBe(200);
            });

            it("feeds the model the ticked corrections of an unfinished review, then the confirmed ones", async () => {
                await readyRun();
                const before = await llmRendering(transcriptId);
                expect(before?.text).toBe(
                    "speaker_0: Dobrý den, máme tu Tavesy.",
                );
                const { items } = (await (
                    await route(getReviewRoute, OWNER, "review")
                ).json()) as {
                    items: { id: string; kind: string; version: number }[];
                };
                const correction = items.find(
                    (item) => item.kind === "correction",
                );
                const phrase = items.find(
                    (item) => item.kind === "relation_phrase",
                );
                const id = correction?.id ?? "";
                await route(patchItemRoute, OWNER, `review/items/${id}`, {
                    method: "PATCH",
                    body: { decision: "accepted", version: 0, choice: null },
                    params: { itemId: id },
                });
                const ticked = await llmRendering(transcriptId);
                expect(ticked?.text).toBe(
                    "speaker_0: Dobrý den, máme tu Tavesi.",
                );
                expect(ticked?.fingerprint).not.toBe(before?.fingerprint);

                await route(postFinishRoute, OWNER, "review/finish", {
                    method: "POST",
                    body: {
                        versions: { [id]: 1, [phrase?.id ?? ""]: 0 },
                    },
                });
                const finished = await llmRendering(transcriptId);
                expect(finished?.text).toBe(ticked?.text);
                expect(finished?.fingerprint).toBe(ticked?.fingerprint);
                expect(finished?.turns[0]?.text).toBe(
                    "Dobrý den, máme tu Tavesi.",
                );
            });

            it("lists a transcript's corrections with what they mean, and undoes one for whoever may change it", async () => {
                const { tavesi } = await readyRun();
                const { items } = (await (
                    await route(getReviewRoute, OWNER, "review")
                ).json()) as {
                    items: { id: string; kind: string }[];
                };
                const id =
                    items.find((item) => item.kind === "correction")?.id ?? "";
                const phrase =
                    items.find((item) => item.kind === "relation_phrase")?.id ??
                    "";
                await route(patchItemRoute, OWNER, `review/items/${id}`, {
                    method: "PATCH",
                    body: { decision: "accepted", version: 0, choice: null },
                    params: { itemId: id },
                });
                await route(postFinishRoute, OWNER, "review/finish", {
                    method: "POST",
                    body: { versions: { [id]: 1, [phrase]: 0 } },
                });

                const listed = await route(
                    getCorrectionsRoute,
                    OWNER,
                    "corrections?source=riffado",
                );
                expect(listed.status).toBe(200);
                const body = (await listed.json()) as {
                    transcriptionId: string;
                    canUndo: boolean;
                    corrections: {
                        id: string;
                        turnIndex: number;
                        charStart: number;
                        heard: string;
                        kind: string;
                        replacement: string | null;
                        meaning: string;
                    }[];
                };
                expect(body).toMatchObject({
                    transcriptionId: transcriptId,
                    canUndo: true,
                    corrections: [
                        {
                            turnIndex: 0,
                            charStart: 19,
                            heard: "Tavesy",
                            kind: "correct",
                            replacement: "Tavesi",
                            meaning: "Tavesi",
                        },
                    ],
                });
                expect(tavesi).toBeTruthy();
                expect(
                    (
                        await route(
                            getCorrectionsRoute,
                            BOB,
                            "corrections?source=riffado",
                        )
                    ).status,
                ).toBe(404);

                const correctionId = body.corrections[0]?.id ?? "";
                const undo = (user: string) =>
                    route(
                        deleteCorrectionRoute,
                        user,
                        `corrections/${correctionId}`,
                        {
                            method: "DELETE",
                            params: { correctionId },
                        },
                    );
                expect((await undo(BOB)).status).toBe(404);
                expect((await undo(OWNER)).status).toBe(200);
                expect(await db().select().from(transcriptCorrections)).toEqual(
                    [],
                );
                expect((await undo(OWNER)).status).toBe(404);
            });

            it("summarizes the corrected transcript, and says when the corrections moved on", async () => {
                await readyRun();
                const { items } = (await (
                    await route(getReviewRoute, OWNER, "review")
                ).json()) as { items: { id: string; kind: string }[] };
                const id =
                    items.find((item) => item.kind === "correction")?.id ?? "";
                const phrase =
                    items.find((item) => item.kind === "relation_phrase")?.id ??
                    "";
                await route(patchItemRoute, OWNER, `review/items/${id}`, {
                    method: "PATCH",
                    body: { decision: "accepted", version: 0, choice: null },
                    params: { itemId: id },
                });
                await route(postFinishRoute, OWNER, "review/finish", {
                    method: "POST",
                    body: { versions: { [id]: 1, [phrase]: 0 } },
                });

                createCompletion.mockReset();
                reply({
                    summary: "Tavesi came.",
                    keyPoints: [],
                    actionItems: [],
                });
                await generateSummaryForRecording(OWNER, REC);
                const sent = JSON.stringify(
                    createCompletion.mock.calls[0]?.[0],
                );
                expect(sent).toContain("máme tu Tavesi.");
                expect(sent).not.toContain("Tavesy");
                const summary = async () =>
                    (await (
                        await route(getSummaryRoute, OWNER, "summary")
                    ).json()) as { summary: string; stale?: boolean };
                expect(await summary()).toMatchObject({
                    summary: expect.stringContaining("Tavesi"),
                    stale: false,
                });

                const [correction] = await db()
                    .select({ id: transcriptCorrections.id })
                    .from(transcriptCorrections);
                await route(
                    deleteCorrectionRoute,
                    OWNER,
                    `corrections/${correction?.id}`,
                    {
                        method: "DELETE",
                        params: { correctionId: correction?.id ?? "" },
                    },
                );
                expect((await summary()).stale).toBe(true);
                // Auto-summarize is off: nothing is summarized again.
                expect(
                    await db()
                        .select()
                        .from(asyncJobs)
                        .where(eq(asyncJobs.kind, "summary")),
                ).toEqual([]);
            });

            it("summarizes again when the corrections change and auto-summarize is on", async () => {
                await readyRun();
                const { items } = (await (
                    await route(getReviewRoute, OWNER, "review")
                ).json()) as { items: { id: string; kind: string }[] };
                const id =
                    items.find((item) => item.kind === "correction")?.id ?? "";
                const phrase =
                    items.find((item) => item.kind === "relation_phrase")?.id ??
                    "";
                await route(patchItemRoute, OWNER, `review/items/${id}`, {
                    method: "PATCH",
                    body: { decision: "accepted", version: 0, choice: null },
                    params: { itemId: id },
                });
                await route(postFinishRoute, OWNER, "review/finish", {
                    method: "POST",
                    body: { versions: { [id]: 1, [phrase]: 0 } },
                });
                createCompletion.mockReset();
                reply({
                    summary: "Tavesi came.",
                    keyPoints: [],
                    actionItems: [],
                });
                await generateSummaryForRecording(OWNER, REC);
                const summaryJobs = () =>
                    db()
                        .select()
                        .from(asyncJobs)
                        .where(eq(asyncJobs.kind, "summary"));
                const undoLast = async () => {
                    const [correction] = await db()
                        .select({ id: transcriptCorrections.id })
                        .from(transcriptCorrections);
                    await route(
                        deleteCorrectionRoute,
                        OWNER,
                        `corrections/${correction?.id}`,
                        {
                            method: "DELETE",
                            params: { correctionId: correction?.id ?? "" },
                        },
                    );
                };

                await db().insert(userSettings).values({
                    userId: OWNER,
                    autoSummarize: true,
                });
                await undoLast();
                expect(await summaryJobs()).toMatchObject([
                    { userId: OWNER, status: "pending" },
                ]);
            });

            it("exports the transcript as people read it: its confirmed corrections applied", async () => {
                await readyRun();
                const { items } = (await (
                    await route(getReviewRoute, OWNER, "review")
                ).json()) as { items: { id: string; kind: string }[] };
                const id =
                    items.find((item) => item.kind === "correction")?.id ?? "";
                const phrase =
                    items.find((item) => item.kind === "relation_phrase")?.id ??
                    "";
                const exported = async () =>
                    (
                        await getRecordingMarkdownDocument(
                            OWNER,
                            REC,
                            "transcript",
                            { source: "riffado" },
                        )
                    )?.content;
                // Ticked in a review not yet finished: not in an export.
                await route(patchItemRoute, OWNER, `review/items/${id}`, {
                    method: "PATCH",
                    body: { decision: "accepted", version: 0, choice: null },
                    params: { itemId: id },
                });
                expect(await exported()).not.toContain("Tavesi");
                await route(postFinishRoute, OWNER, "review/finish", {
                    method: "POST",
                    body: { versions: { [id]: 1, [phrase]: 0 } },
                });
                const content = await exported();
                expect(content).toContain("máme tu Tavesi.");
                expect(content).not.toContain("Tavesy");
            });

            it("says at share time whether the summary reads as the Organization will", async () => {
                await readyRun();
                const { items } = (await (
                    await route(getReviewRoute, OWNER, "review")
                ).json()) as { items: { id: string; kind: string }[] };
                const id =
                    items.find((item) => item.kind === "correction")?.id ?? "";
                const phrase =
                    items.find((item) => item.kind === "relation_phrase")?.id ??
                    "";
                await route(patchItemRoute, OWNER, `review/items/${id}`, {
                    method: "PATCH",
                    body: { decision: "accepted", version: 0, choice: null },
                    params: { itemId: id },
                });
                await route(postFinishRoute, OWNER, "review/finish", {
                    method: "POST",
                    body: { versions: { [id]: 1, [phrase]: 0 } },
                });
                createCompletion.mockReset();
                reply({
                    summary: "Tavesi came.",
                    keyPoints: [],
                    actionItems: [],
                });
                await generateSummaryForRecording(OWNER, REC);

                const [root] = await db()
                    .select({ id: recordingFolders.id })
                    .from(recordingFolders)
                    .where(eq(recordingFolders.userId, orgUserId));
                const shared = await route(shareRoute, OWNER, "folders", {
                    method: "POST",
                    body: { folderId: root?.id ?? "" },
                });
                // The owner's corrections are published with it, so the
                // Organization reads what the summary read.
                expect(await shared.json()).toEqual({
                    assigned: true,
                    summaryStale: false,
                });
                const orgSummary = async () =>
                    (
                        (await (
                            await route(
                                getSummaryRoute,
                                OWNER,
                                "summary?view=org",
                            )
                        ).json()) as { stale?: boolean }
                    ).stale;
                expect(await orgSummary()).toBe(false);
                // The Organization takes the correction back: it now reads
                // otherwise than the summary did.
                const [correction] = await db()
                    .select({ id: transcriptCorrections.id })
                    .from(transcriptCorrections);
                await route(
                    deleteCorrectionRoute,
                    orgUserId,
                    `corrections/${correction?.id}?view=org`,
                    {
                        method: "DELETE",
                        params: { correctionId: correction?.id ?? "" },
                    },
                );
                expect(await orgSummary()).toBe(true);
            });

            it("summarizes again after a finish that applied nothing but took back what the summary read", async () => {
                await readyRun();
                const { items } = (await (
                    await route(getReviewRoute, OWNER, "review")
                ).json()) as { items: { id: string; kind: string }[] };
                const id =
                    items.find((item) => item.kind === "correction")?.id ?? "";
                const phrase =
                    items.find((item) => item.kind === "relation_phrase")?.id ??
                    "";
                await route(patchItemRoute, OWNER, `review/items/${id}`, {
                    method: "PATCH",
                    body: { decision: "accepted", version: 0, choice: null },
                    params: { itemId: id },
                });
                // Summarized while the review waits: the tick is read.
                createCompletion.mockReset();
                reply({
                    summary: "Tavesi came.",
                    keyPoints: [],
                    actionItems: [],
                });
                await generateSummaryForRecording(OWNER, REC);
                // No correction pass: it would refresh the summary itself,
                // once it ends.
                await db().insert(userSettings).values({
                    userId: OWNER,
                    autoSummarize: true,
                    correctAfterLearn: false,
                });
                // Unticked after all, and finished: nothing applied.
                await route(patchItemRoute, OWNER, `review/items/${id}`, {
                    method: "PATCH",
                    body: { decision: "rejected", version: 1, choice: null },
                    params: { itemId: id },
                });
                const finished = await route(
                    postFinishRoute,
                    OWNER,
                    "review/finish",
                    {
                        method: "POST",
                        body: { versions: { [id]: 2, [phrase]: 0 } },
                    },
                );
                await expect(finished.json()).resolves.toMatchObject({
                    status: "finished",
                    applied: 0,
                });
                expect(
                    await db()
                        .select()
                        .from(asyncJobs)
                        .where(eq(asyncJobs.kind, "summary")),
                ).toMatchObject([{ userId: OWNER, status: "pending" }]);
            });

            it("supersedes instead of finishing when the transcript changed", async () => {
                const { runId } = await readyRun();
                await db()
                    .update(transcriptions)
                    .set({ revision: 9 })
                    .where(eq(transcriptions.id, transcriptId));
                const finished = await route(
                    postFinishRoute,
                    OWNER,
                    "review/finish",
                    { method: "POST", body: {} },
                );
                await expect(finished.json()).resolves.toMatchObject({
                    status: "superseded",
                });
                expect((await statusAndStats(runId))?.status).toBe(
                    "superseded",
                );
                expect(await db().select().from(transcriptCorrections)).toEqual(
                    [],
                );
            });
        });
    });

    it("lists the reviews waiting, naming only recordings the viewer may see now", async () => {
        await run("private", "ready");
        expect(await reviewQueue(OWNER, false)).toMatchObject([
            { id: REC, filename: "Weekly" },
        ]);
        // An Organization run on a recording no longer shared (a
        // withdrawal landing between two reads).
        await db().delete(learnRuns);
        await run("org", "ready");
        expect(await reviewQueue(orgUserId, true)).toEqual([]);
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await db()
            .insert(recordingFolderAssignments)
            .values({
                userId: orgUserId,
                itemId: REC,
                folderId: root?.id ?? "",
            });
        expect(await reviewQueue(orgUserId, true)).toMatchObject([
            { id: REC, filename: "Weekly" },
        ]);
        expect(await reviewQueue(BOB, false)).toEqual([]);
    });

    it("hands a member none of the owner's private corrections when a withdrawal lands mid-request", async () => {
        await db()
            .update(transcriptions)
            .set({
                turns: encryptJsonField([
                    {
                        speaker: "speaker_0",
                        startMs: 0,
                        endMs: 5_000,
                        text: "Dobrý den, máme tu Tavesy.",
                    },
                ]),
            })
            .where(eq(transcriptions.id, transcriptId));
        const typeKey = await createPrivateType(OWNER, {
            kind: "entity",
            label: "Secret project",
        });
        const secret = (
            await createEntity(OWNER, { typeKey, name: "Project Nightjar" })
        ).id;
        await acceptCorrection({
            userId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            anchor: {
                turnIndex: 0,
                charStart: 19,
                charEnd: 25,
                heard: "Tavesy",
            },
            kind: "correct",
            target: { entityId: secret },
            replacement: "Nightjar-Private",
        });
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: root?.id ?? "",
        });
        knowledgeStore().invalidateAll();
        const withdrawMidRequest = () => {
            afterAuthorize.current = async () => {
                await unshareRecording(OWNER, REC, { withdraw: true });
            };
        };

        withdrawMidRequest();
        const markdown = await getMarkdownRoute(
            new Request(
                `http://localhost/api/recordings/${REC}/markdown/transcript?view=org&source=riffado`,
                { headers: { "x-test-user": BOB } },
            ),
            { params: Promise.resolve({ id: REC, kind: "transcript" }) },
        );
        expect(await markdown.text()).not.toContain("Nightjar");
        expect(markdown.status).toBe(404);
    });

    it("counts the reviews waiting for each: the owner's own, the Organization's for its account", async () => {
        await run("private", "ready");
        await run("private", "finished");
        await run("org", "ready");
        expect(await pendingReviewCount(OWNER, false)).toBe(1);
        expect([...(await recordingsNeedingReview(OWNER, false))]).toEqual([
            REC,
        ]);
        expect(await pendingReviewCount(BOB, false)).toBe(0);
        expect(await pendingReviewCount(orgUserId, true)).toBe(1);
        const answer = await getPending(
            new Request("http://localhost/api/learn/pending", {
                headers: { "x-test-user": OWNER },
            }),
            { params: Promise.resolve({}) },
        );
        await expect(answer.json()).resolves.toEqual({ count: 1 });
    });

    it("goes into its owner's archive with what it proposed, and the Organization's runs do not", async () => {
        const mine = await run("private", "ready");
        await db()
            .insert(learnReviewItems)
            .values({
                runId: mine,
                userId: OWNER,
                kind: "correction",
                fingerprintHmac: "f",
                payload: encryptJsonField({ heard: "Tavesy" }),
                preTicked: true,
            });
        await run("org", "ready");

        const storage = new ArchiveStorage();
        await buildAndUploadExportArchive({
            scope: { kind: "personal", userId: OWNER },
            sourceStorage: storage,
            destinationStorage: storage,
            storageKey: "exports/owner.zip",
        });
        const directory = await unzipper.Open.buffer(storage.uploaded);
        const file = directory.files.find(
            (entry) => entry.path === "knowledge/learn.json",
        );
        const learnJson = JSON.parse(
            (await file?.buffer())?.toString("utf-8") ?? "{}",
        );
        expect(learnJson.runs.map((row: { id: string }) => row.id)).toEqual([
            mine,
        ]);
        expect(learnJson.items).toEqual([
            {
                runId: mine,
                kind: "correction",
                preTicked: true,
                decision: null,
                dependsOnLabel: null,
                payload: { heard: "Tavesy" },
            },
        ]);
    });
});

/** Captures the archive; the recording's audio is not there. */
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
