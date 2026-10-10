/**
 * Finishing a Learn review against a real PostgreSQL, where it meets
 * knowledge that moved on: the Phase 4 review's findings (Opus M1-M5, L1;
 * Codex 1, 3-6), each a scenario that went wrong.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { and, eq, isNull } from "drizzle-orm";
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
    knowledgeFactEvidence,
    knowledgeFacts,
    learnDismissals,
    learnReviewItems,
    learnRuns,
    transcriptCorrections,
    transcriptions,
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
                if (!current)
                    throw new Error("test database was not initialized");
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        deleteFile: vi.fn().mockResolvedValue(undefined),
    }),
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

import { POST as postLearnRoute } from "@/app/api/recordings/[id]/learn/route";
import { DELETE as deleteDismissalsRoute } from "@/app/api/recordings/[id]/review/dismissals/route";
import { POST as postFinishRoute } from "@/app/api/recordings/[id]/review/finish/route";
import { PATCH as patchItemRoute } from "@/app/api/recordings/[id]/review/items/[itemId]/route";
import { GET as getReviewRoute } from "@/app/api/recordings/[id]/review/route";
import { encrypt } from "@/lib/encryption";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { createEntity } from "@/lib/knowledge/entities";
import { confirmManualFact } from "@/lib/knowledge/facts";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { createPerson } from "@/lib/knowledge/people";
import { changeTranscriptSpeaker } from "@/lib/knowledge/speaker-changes";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { pendingReviewCount } from "@/lib/learn/pending";
import { ensureOrgAccount } from "@/lib/org/account";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const REC = "rec-finish";
const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 5_000,
        text: "Tavesy a tavesy.",
    },
    {
        speaker: "speaker_1",
        startMs: 5_000,
        endMs: 10_000,
        text: "Já vedu Orion.",
    },
];

describeWithDatabase("finishing a Learn review (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let transcriptId = "";
    const db = () => {
        if (!database) throw new Error("no db");
        return database.db;
    };

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "review_finish",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        knowledgeStore().invalidateAll();
        await db().delete(users);
        await db()
            .insert(users)
            .values([{ id: OWNER, email: "o@example.test" }]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await seedCoreVocabulary();
        await insertRecordings(db(), {
            id: REC,
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 10_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:10Z"),
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
                text: encryptText(TURNS.map((t) => t.text).join("\n")),
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

    const readyRun = async (
        items: {
            kind:
                | "speaker"
                | "correction"
                | "known_fact"
                | "fact"
                | "relation_phrase";
            payload: object;
            preTicked?: boolean;
            decision?: "accepted" | "rejected" | null;
            choice?: object | null;
            dependsOnLabel?: string | null;
        }[],
        view: "private" | "org" = "private",
    ) => {
        const [run] = await db()
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
                status: "ready",
            })
            .returning({ id: learnRuns.id });
        const runId = run?.id ?? "";
        let n = 0;
        for (const item of items) {
            await db()
                .insert(learnReviewItems)
                .values({
                    runId,
                    userId: view === "org" ? orgUserId : OWNER,
                    kind: item.kind,
                    fingerprintHmac: `fp-${runId}-${n++}`,
                    payload: encryptJsonField(item.payload),
                    preTicked: item.preTicked ?? false,
                    decision: item.decision ?? null,
                    choice: item.choice ? encryptJsonField(item.choice) : null,
                    dependsOnLabel: item.dependsOnLabel ?? null,
                });
        }
        return runId;
    };

    /** Finish with the versions of every item, as the review shows them. */
    const finish = async (
        user = OWNER,
        view?: "org",
        versions?: Record<string, number>,
    ) => {
        const shown =
            versions ??
            Object.fromEntries(
                (
                    await db()
                        .select({
                            id: learnReviewItems.id,
                            version: learnReviewItems.version,
                        })
                        .from(learnReviewItems)
                ).map((item) => [item.id, item.version]),
            );
        const response = await postFinishRoute(
            new Request(
                `http://localhost/api/recordings/${REC}/review/finish${view ? "?view=org" : ""}`,
                {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user": user,
                    },
                    body: JSON.stringify({ versions: shown }),
                },
            ),
            { params: Promise.resolve({ id: REC }) },
        );
        return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>,
        };
    };

    it("gives back the ready review instead of starting another run beside it", async () => {
        const ready = await readyRun([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: null,
                    evidenceMs: [5000],
                    reason: "x",
                },
            },
        ]);
        await db()
            .insert(apiCredentials)
            .values({
                userId: OWNER,
                provider: "openai",
                apiKey: encrypt("key"),
                defaultModel: "gpt-4o-mini",
                isDefaultEnhancement: true,
            });
        const started = await postLearnRoute(
            new Request(`http://localhost/api/recordings/${REC}/learn`, {
                method: "POST",
                headers: { "x-test-user": OWNER },
            }),
            { params: Promise.resolve({ id: REC }) },
        );
        expect(await started.json()).toMatchObject({
            runId: ready,
            jobId: null,
            created: false,
        });
        expect(await db().select().from(learnRuns)).toHaveLength(1);
        const review = await getReviewRoute(
            new Request(`http://localhost/api/recordings/${REC}/review`, {
                headers: { "x-test-user": OWNER },
            }),
            { params: Promise.resolve({ id: REC }) },
        );
        expect(await review.json()).toMatchObject({
            run: { id: ready, status: "ready" },
        });
        expect(await pendingReviewCount(OWNER, false)).toBe(1);
    });

    async function janAndOrion() {
        const jan = (
            await createPerson({ userId: OWNER, displayName: "Jan Novotný" })
        ).id;
        const orion = (
            await createEntity(OWNER, { typeKey: "project", name: "Orion" })
        ).id;
        return { jan, orion };
    }

    const leads = (
        subject: object,
        orion: string,
        speakerLabel: string | null,
    ) => ({
        kind: "fact" as const,
        payload: {
            subject,
            relationKey: "leads",
            object: { entityId: orion },
            startMs: 5000,
            endMs: 10000,
            speakerLabel,
        },
        dependsOnLabel: "speaker_1",
        decision: "accepted" as const,
    });

    const review = async () => {
        const response = await getReviewRoute(
            new Request(`http://localhost/api/recordings/${REC}/review`, {
                headers: { "x-test-user": OWNER },
            }),
            { params: Promise.resolve({ id: REC }) },
        );
        return (await response.json()) as {
            run: Record<string, unknown> | null;
            items: { id: string; kind: string; outcome: string | null }[];
            names: Record<string, string>;
            known?: { people: number; things: number };
        };
    };

    it("keeps what became of each item, and shows the finished review with it", async () => {
        const { jan, orion } = await janAndOrion();
        await readyRun([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: jan,
                    evidenceMs: [5000],
                    reason: "x",
                },
                decision: "accepted",
            },
            leads({ speakerLabel: "speaker_1" }, orion, "speaker_1"),
            // Ticked, but about a speaker nobody named.
            { ...leads({ speakerLabel: "speaker_0" }, orion, "speaker_0") },
            {
                kind: "fact",
                payload: {
                    subject: { personId: jan },
                    relationKey: "works_on",
                    object: { entityId: orion },
                    startMs: 5000,
                    endMs: 10000,
                    speakerLabel: null,
                },
                decision: "rejected",
            },
        ]);
        expect((await finish()).body).toMatchObject({ applied: 2 });

        const shown = await review();
        expect(shown.run).toMatchObject({
            status: "finished",
            errorCode: null,
        });
        expect(shown.items.map((item) => item.outcome)).toEqual([
            "applied",
            "applied",
            "speaker_not_named",
            "rejected",
        ]);
        expect(shown.names[jan]).toBe("Jan Novotný");
        expect(shown.known).toBeUndefined();
    });

    it("says how much a run that found nothing had to go on", async () => {
        await janAndOrion();
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: OWNER,
                itemId: REC,
                transcriptionId: transcriptId,
                view: "private",
                actorUserId: OWNER,
                trigger: "manual",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "finished",
                finishedAt: new Date(),
            })
            .returning({ id: learnRuns.id });
        const shown = await review();
        expect(shown.run).toMatchObject({ id: run?.id, status: "finished" });
        expect(shown.items).toEqual([]);
        expect(shown.known).toEqual({ people: 1, things: 1 });
    });

    it("forgets the rejections on this recording in this view, and nothing else", async () => {
        const other = "rec-other";
        await insertRecordings(db(), {
            id: other,
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: "plaud-2",
            filename: encryptText("Other"),
            duration: 10_000,
            startTime: new Date("2026-09-02T10:00:00Z"),
            endTime: new Date("2026-09-02T10:00:10Z"),
            filesize: 11,
            fileMd5: "1".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/other.mp3`,
            plaudVersion: "1",
        });
        await db()
            .insert(learnDismissals)
            .values([
                { userId: OWNER, itemId: REC, fingerprintHmac: "a" },
                { userId: OWNER, itemId: REC, fingerprintHmac: "b" },
                { userId: OWNER, itemId: other, fingerprintHmac: "a" },
                { userId: orgUserId, itemId: REC, fingerprintHmac: "a" },
            ]);
        const response = await deleteDismissalsRoute(
            new Request(
                `http://localhost/api/recordings/${REC}/review/dismissals`,
                { method: "DELETE", headers: { "x-test-user": OWNER } },
            ),
            { params: Promise.resolve({ id: REC }) },
        );
        expect(await response.json()).toEqual({ forgotten: 2 });
        const left = await db()
            .select({
                userId: learnDismissals.userId,
                recordingId: learnDismissals.itemId,
            })
            .from(learnDismissals);
        expect(left).toHaveLength(2);
        expect(left).toEqual(
            expect.arrayContaining([
                { userId: OWNER, recordingId: other },
                { userId: orgUserId, recordingId: REC },
            ]),
        );
    });

    it("says why a run failed, and shows no items", async () => {
        await db().insert(learnRuns).values({
            userId: OWNER,
            scopeUserId: OWNER,
            itemId: REC,
            transcriptionId: transcriptId,
            view: "private",
            actorUserId: OWNER,
            trigger: "manual",
            transcriptRevision: 0,
            vocabularyVersion: 0,
            status: "failed",
            errorCode: "AI_PROVIDER_API_ERROR",
            finishedAt: new Date(),
        });
        const shown = await review();
        expect(shown.run).toMatchObject({
            status: "failed",
            errorCode: "AI_PROVIDER_API_ERROR",
        });
        expect(shown.items).toEqual([]);
    });

    it("skips a fact whose speaker was not named: the suggestion rejected, or answered unknown", async () => {
        const { jan, orion } = await janAndOrion();
        await readyRun([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: jan,
                    evidenceMs: [5000],
                    reason: "x",
                },
                decision: "rejected",
            },
            leads({ personId: jan }, orion, "speaker_1"),
        ]);
        expect((await finish()).body).toMatchObject({
            applied: 0,
            skipped: [{ reason: "Its speaker is not named yet" }],
        });
        expect(await db().select().from(knowledgeFacts)).toEqual([]);

        await db().delete(learnRuns);
        await readyRun([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: jan,
                    evidenceMs: [5000],
                    reason: "x",
                },
                decision: "accepted",
                choice: { unknown: true },
            },
            leads({ personId: jan }, orion, "speaker_1"),
        ]);
        expect((await finish()).body).toMatchObject({
            skipped: [{ reason: "Its speaker is not named yet" }],
        });
        expect(await db().select().from(knowledgeFacts)).toEqual([]);
    });

    it("keeps a fact about a speaker tied to that speaker, so renaming them takes its support", async () => {
        const { jan, orion } = await janAndOrion();
        const petr = (
            await createPerson({ userId: OWNER, displayName: "Petr" })
        ).id;
        await readyRun([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: jan,
                    evidenceMs: [5000],
                    reason: "x",
                },
                decision: "accepted",
            },
            leads({ speakerLabel: "speaker_1" }, orion, null),
        ]);
        expect((await finish()).body).toMatchObject({
            applied: 2,
            skipped: [],
        });
        const [before] = await db().select().from(knowledgeFactEvidence);
        expect(before).toMatchObject({
            speakerLabel: "speaker_1",
            dependsOnSpeaker: true,
            status: "supported",
        });
        await changeTranscriptSpeaker({
            userId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            label: "speaker_1",
            answer: { kind: "name", personId: petr },
            actorUserId: OWNER,
            orgUserId,
        });
        const [after] = await db().select().from(knowledgeFactEvidence);
        expect(after?.status).not.toBe("supported");
    });

    it("applies a correction to all its occurrences or none, each at its own words", async () => {
        const tavesi = (
            await createEntity(OWNER, {
                typeKey: "organization",
                name: "Tavesi",
            })
        ).id;
        const correction = (anchors: object[]) => ({
            kind: "correction" as const,
            payload: {
                kind: "correct",
                heard: "Tavesy",
                target: { entityId: tavesi },
                replacement: "Tavesi",
                anchors,
            },
            decision: "accepted" as const,
        });
        await readyRun([
            correction([
                { turnIndex: 0, charStart: 0, charEnd: 6 },
                { turnIndex: 0, charStart: 9, charEnd: 15 },
            ]),
        ]);
        expect((await finish()).body).toMatchObject({
            applied: 1,
            skipped: [],
        });
        expect(await db().select().from(transcriptCorrections)).toHaveLength(2);

        await db().delete(transcriptCorrections);
        await db().delete(learnRuns);
        await readyRun([
            correction([
                { turnIndex: 0, charStart: 0, charEnd: 6 },
                // No longer those words.
                { turnIndex: 1, charStart: 0, charEnd: 6 },
            ]),
        ]);
        expect((await finish()).body).toMatchObject({
            applied: 0,
            skipped: [{ reason: expect.any(String) }],
        });
        expect(await db().select().from(transcriptCorrections)).toEqual([]);
    });

    it("applies a correction at every occurrence however its words are composed", async () => {
        const cafe = (
            await createEntity(OWNER, {
                typeKey: "organization",
                name: "Kavárna",
            })
        ).id;
        // "Café", composed, then as "e" and an accent.
        const turns = [
            { ...TURNS[0], text: "Caf\u00e9 a Cafe\u0301." },
            TURNS[1],
        ] as TranscriptTurn[];
        await db()
            .update(transcriptions)
            .set({
                text: encryptText(turns.map((t) => t.text).join("\n")),
                turns: encryptJsonField(turns),
            })
            .where(eq(transcriptions.id, transcriptId));
        await readyRun([
            {
                kind: "correction",
                payload: {
                    kind: "link",
                    heard: "Caf\u00e9",
                    target: { entityId: cafe },
                    replacement: null,
                    anchors: [
                        { turnIndex: 0, charStart: 0, charEnd: 4 },
                        { turnIndex: 0, charStart: 7, charEnd: 12 },
                    ],
                },
                decision: "accepted",
            },
        ]);
        expect((await finish()).body).toMatchObject({
            applied: 1,
            skipped: [],
        });
        expect(await db().select().from(transcriptCorrections)).toHaveLength(2);
    });

    it("does not put back a value the person replaced after the run", async () => {
        const jan = (await createPerson({ userId: OWNER, displayName: "Jan" }))
            .id;
        const tavesi = (
            await createEntity(OWNER, {
                typeKey: "organization",
                name: "Tavesi",
            })
        ).id;
        const other = (
            await createEntity(OWNER, { typeKey: "organization", name: "Acme" })
        ).id;
        const known = await confirmManualFact(OWNER, {
            subject: { personId: jan },
            relationKey: "works_for",
            object: { entityId: tavesi },
            expectedCurrentFactId: null,
        });
        await readyRun([
            {
                kind: "known_fact",
                preTicked: true,
                payload: {
                    factId: known,
                    subject: { personId: jan },
                    relationKey: "works_for",
                    object: { entityId: tavesi },
                    startMs: 0,
                    endMs: 5000,
                    speakerLabel: null,
                },
            },
            {
                kind: "fact",
                decision: "accepted",
                payload: {
                    subject: { personId: jan },
                    relationKey: "works_for",
                    object: { entityId: tavesi },
                    startMs: 0,
                    endMs: 5000,
                    speakerLabel: null,
                    replaces: { factId: known, object: { entityId: tavesi } },
                },
            },
        ]);
        const acme = await confirmManualFact(OWNER, {
            subject: { personId: jan },
            relationKey: "works_for",
            object: { entityId: other },
            expectedCurrentFactId: known,
        });
        const result = await finish();
        expect(result.body).toMatchObject({ applied: 0 });
        expect((result.body.skipped as unknown[]).length).toBe(2);
        const current = await db()
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(
                and(
                    eq(knowledgeFacts.relationKey, "works_for"),
                    isNull(knowledgeFacts.replacedByFactId),
                ),
            );
        expect(current.map((row) => row.id)).toEqual([acme]);
    });

    it("makes no private copy of an Organization fact mentioned again", async () => {
        const jan = (
            await createPerson({ userId: orgUserId, displayName: "Jan" })
        ).id;
        const tavesi = (
            await createEntity(orgUserId, {
                typeKey: "organization",
                name: "Tavesi",
            })
        ).id;
        const orgFact = await confirmManualFact(orgUserId, {
            subject: { personId: jan },
            relationKey: "member_of",
            object: { entityId: tavesi },
        });
        await readyRun([
            {
                kind: "known_fact",
                preTicked: true,
                payload: {
                    factId: orgFact,
                    subject: { personId: jan },
                    relationKey: "member_of",
                    object: { entityId: tavesi },
                    startMs: 0,
                    endMs: 5000,
                    speakerLabel: null,
                },
            },
        ]);
        await finish();
        expect(
            (await db().select().from(knowledgeFacts)).filter(
                (fact) => fact.userId === OWNER,
            ),
        ).toEqual([]);
    });

    it("finishes only with every item's version, as shown", async () => {
        const { jan } = await janAndOrion();
        await readyRun([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: jan,
                    evidenceMs: [5000],
                    reason: "x",
                },
            },
        ]);
        expect((await finish(OWNER, undefined, {})).status).toBe(409);
        const [item] = await db().select().from(learnReviewItems);
        expect(
            (
                await finish(OWNER, undefined, {
                    [item?.id ?? ""]: 0,
                    "not-an-item": 0,
                })
            ).status,
        ).toBe(409);
        expect((await finish()).status).toBe(200);
    });

    it("keeps no draft for a review already finished", async () => {
        const { jan } = await janAndOrion();
        await readyRun([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: jan,
                    evidenceMs: [5000],
                    reason: "x",
                },
            },
        ]);
        const [item] = await db().select().from(learnReviewItems);
        await finish();
        const patched = await patchItemRoute(
            new Request(
                `http://localhost/api/recordings/${REC}/review/items/${item?.id}`,
                {
                    method: "PATCH",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user": OWNER,
                    },
                    body: JSON.stringify({
                        decision: "accepted",
                        version: 0,
                        choice: null,
                    }),
                },
            ),
            { params: Promise.resolve({ id: REC, itemId: item?.id ?? "" }) },
        );
        expect(patched.status).toBe(404);
    });

    it("skips a speaker someone answered since the run", async () => {
        const { jan } = await janAndOrion();
        const petr = (
            await createPerson({ userId: OWNER, displayName: "Petr" })
        ).id;
        await readyRun([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: jan,
                    evidenceMs: [5000],
                    reason: "x",
                },
                decision: "accepted",
            },
        ]);
        await changeTranscriptSpeaker({
            userId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            label: "speaker_1",
            answer: { kind: "name", personId: petr },
            actorUserId: OWNER,
            orgUserId,
        });
        expect((await finish()).body).toMatchObject({
            applied: 0,
            skipped: [{ reason: "Answered since" }],
        });
        const [speaker] = await db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.label, "speaker_1"));
        expect(speaker?.personId).toBe(petr);
    });

    it("keeps a review to its transcript: the other source's panel sees none", async () => {
        const [plaud] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: OWNER,
                text: encryptText("Plaud text."),
                turns: encryptJsonField(TURNS),
                provider: "plaud",
                model: "plaud-native",
                source: "plaud",
            })
            .returning({ id: transcriptions.id });
        const [run] = await db()
            .insert(learnRuns)
            .values({
                userId: OWNER,
                scopeUserId: OWNER,
                itemId: REC,
                transcriptionId: plaud?.id ?? "",
                view: "private",
                actorUserId: OWNER,
                trigger: "manual",
                transcriptRevision: 0,
                vocabularyVersion: 0,
                status: "ready",
            })
            .returning({ id: learnRuns.id });
        const review = async (source: string) =>
            (await (
                await getReviewRoute(
                    new Request(
                        `http://localhost/api/recordings/${REC}/review?source=${source}`,
                        { headers: { "x-test-user": OWNER } },
                    ),
                    { params: Promise.resolve({ id: REC }) },
                )
            ).json()) as { run: { id: string } | null };
        expect((await review("plaud")).run?.id).toBe(run?.id);
        expect((await review("riffado")).run).toBeNull();
    });

    const patch = (itemId: string, body: string) =>
        patchItemRoute(
            new Request(
                `http://localhost/api/recordings/${REC}/review/items/${itemId}`,
                {
                    method: "PATCH",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user": OWNER,
                    },
                    body,
                },
            ),
            { params: Promise.resolve({ id: REC, itemId }) },
        );

    it("names a speaker someone new, as chosen in the review", async () => {
        await readyRun([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: null,
                    evidenceMs: [5000],
                    reason: "x",
                },
            },
        ]);
        const [item] = await db().select().from(learnReviewItems);
        const kept = await patch(
            item?.id ?? "",
            JSON.stringify({
                decision: "accepted",
                version: 0,
                choice: { displayName: "  Petra Malá " },
            }),
        );
        expect(kept.status).toBe(200);
        expect((await finish()).body).toMatchObject({ applied: 1 });
        const [speaker] = await db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.label, "speaker_1"));
        expect(speaker?.status).toBe("confirmed");
        expect(speaker?.personId).toBeTruthy();
    });

    it("bounds what a draft may carry", async () => {
        const { jan } = await janAndOrion();
        await readyRun([
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: jan,
                    evidenceMs: [5000],
                    reason: "x",
                },
            },
            {
                kind: "relation_phrase",
                payload: {
                    phrase: "vede",
                    subject: { personId: jan },
                    objectKind: "literal",
                    startMs: 5000,
                    endMs: 10000,
                    count: 1,
                },
            },
        ]);
        const items = await db().select().from(learnReviewItems);
        const speaker = items.find((item) => item.kind === "speaker");
        const phrase = items.find((item) => item.kind === "relation_phrase");
        const tooLongName = await patch(
            speaker?.id ?? "",
            JSON.stringify({
                decision: "accepted",
                version: 0,
                choice: { displayName: "x".repeat(201) },
            }),
        );
        expect(tooLongName.status).toBe(400);
        const tooManyTypes = await patch(
            phrase?.id ?? "",
            JSON.stringify({
                decision: "accepted",
                version: 0,
                choice: {
                    action: "create",
                    spec: {
                        label: "vede",
                        subjectTypes: Array.from(
                            { length: 21 },
                            () => "person",
                        ),
                        objectTypes: [],
                        objectKind: "literal",
                        cardinality: "many",
                    },
                },
            }),
        );
        expect(tooManyTypes.status).toBe(400);
        const huge = await patch(
            speaker?.id ?? "",
            JSON.stringify({
                decision: "accepted",
                version: 0,
                padding: "x".repeat(20_000),
            }),
        );
        expect(huge.status).toBe(413);
    });
});
