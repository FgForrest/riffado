/**
 * Finishing a Learn review whose run proposed new people and things,
 * against a real PostgreSQL: they are added first, and what refers to them
 * is written on the records they became.
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
    knowledgeAliases,
    knowledgeEntities,
    knowledgeFacts,
    knowledgeRelationTypes,
    learnDismissals,
    learnReviewItems,
    learnRuns,
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

import { POST as postFinishRoute } from "@/app/api/recordings/[id]/review/finish/route";
import { PATCH as patchItemRoute } from "@/app/api/recordings/[id]/review/items/[itemId]/route";
import { GET as getReviewRoute } from "@/app/api/recordings/[id]/review/route";
import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { addRecordingToFolder } from "@/lib/folders/folders";
import { createEntity, mergeEntities } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { createPerson } from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const REC = "rec-new-records";
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

describeWithDatabase("finishing a review with new records (PostgreSQL)", () => {
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
            "review_new_records",
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
                | "new_record"
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
        const [transcript] = await db()
            .select({ revision: transcriptions.revision })
            .from(transcriptions)
            .where(eq(transcriptions.id, transcriptId));
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
                transcriptRevision: transcript?.revision ?? 0,
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

    const record = (
        ref: string,
        name: string,
        extra: Partial<{
            kind: "person" | "entity";
            typeKey: string | null;
            decision: "accepted" | "rejected" | null;
            choice: object | null;
        }> = {},
    ) => ({
        kind: "new_record" as const,
        payload: {
            ref,
            kind: extra.kind ?? "entity",
            typeKey:
                (extra.kind ?? "entity") === "person"
                    ? null
                    : (extra.typeKey ?? "organization"),
            name,
            evidenceMs: [0],
            reason: "named",
        },
        decision: extra.decision === undefined ? "accepted" : extra.decision,
        choice: extra.choice ?? null,
    });

    const worksFor = (subject: object, object: object) => ({
        kind: "fact" as const,
        payload: {
            subject,
            relationKey: "works_for",
            object,
            startMs: 0,
            endMs: 10_000,
            speakerLabel: null,
        },
        decision: "accepted" as const,
    });

    const outcomes = async () =>
        (
            await db()
                .select({
                    kind: learnReviewItems.kind,
                    outcome: learnReviewItems.outcome,
                })
                .from(learnReviewItems)
                .orderBy(learnReviewItems.createdAt, learnReviewItems.id)
        ).map((row) => `${row.kind}:${row.outcome}`);

    const entityNamed = async (name: string) => {
        for (const row of await db().select().from(knowledgeEntities)) {
            if (decryptText(row.name) === name) return row;
        }
        return undefined;
    };
    const personNamed = async (name: string) => {
        for (const row of await db().select().from(people)) {
            if (decryptText(row.displayName) === name) return row;
        }
        return undefined;
    };

    it("adds the people and things ticked, and writes what refers to them on them", async () => {
        await readyRun([
            record("n1", "Veltrix"),
            record("n2", "Petra Kolářová", {
                kind: "person",
                // The reviewer corrected the name.
                choice: { name: "Petra Kolářová-Malá", typeKey: null },
            }),
            {
                kind: "speaker",
                payload: {
                    label: "speaker_1",
                    personId: null,
                    newRef: "n2",
                    evidenceMs: [5000],
                    reason: "introduces herself",
                },
                decision: "accepted",
            },
            worksFor({ newRef: "n2" }, { newRef: "n1" }),
        ]);
        const finished = await finish();
        expect(finished.status).toBe(200);
        expect(finished.body).toMatchObject({ applied: 4, skipped: [] });

        const veltrix = await entityNamed("Veltrix");
        const petra = await personNamed("Petra Kolářová-Malá");
        expect(veltrix).toMatchObject({
            userId: OWNER,
            typeKey: "organization",
        });
        expect(petra?.userId).toBe(OWNER);
        const [speaker] = await db()
            .select()
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.label, "speaker_1"));
        expect(speaker).toMatchObject({
            status: "confirmed",
            personId: petra?.id,
        });
        const [fact] = await db().select().from(knowledgeFacts);
        expect(fact).toMatchObject({
            subjectPersonId: petra?.id,
            relationKey: "works_for",
            objectEntityId: veltrix?.id,
        });
        expect(await outcomes()).toEqual([
            "new_record:applied",
            "new_record:applied",
            "speaker:applied",
            "fact:applied",
        ]);
    });

    it("skips what refers to a record left unticked, and does not propose that record on any recording again", async () => {
        const vilem = (
            await createPerson({ userId: OWNER, displayName: "Vilém Brázda" })
        ).id;
        await readyRun([
            record("n1", "Veltrix", { decision: "rejected" }),
            worksFor({ personId: vilem }, { newRef: "n1" }),
        ]);
        expect((await finish()).body).toMatchObject({ applied: 0 });
        expect(await outcomes()).toEqual([
            "new_record:rejected",
            "fact:record_not_added",
        ]);
        expect(await entityNamed("Veltrix")).toBeUndefined();
        const dismissals = await db().select().from(learnDismissals);
        expect(dismissals).toHaveLength(1);
        expect(dismissals[0]).toMatchObject({
            itemId: REC,
            scopeWide: true,
        });
    });

    it("does not ban on every recording a record merely left unticked", async () => {
        await readyRun([record("n1", "Veltrix", { decision: null })]);
        await finish();
        const [dismissal] = await db().select().from(learnDismissals);
        expect(dismissal).toMatchObject({ itemId: REC, scopeWide: false });
    });

    it("refuses a record of someone else's the reviewer names", async () => {
        await db()
            .insert(users)
            .values({ id: "user-bob", email: "bob@example.test" });
        const bobs = (
            await createPerson({ userId: "user-bob", displayName: "Petra K." })
        ).id;
        await readyRun([
            record("n1", "Petra Kolářová", {
                kind: "person",
                choice: { personId: bobs },
            }),
        ]);
        await finish();
        expect(await outcomes()).toEqual(["new_record:no_longer_fits"]);
    });

    it("makes a relation whose side was not added, without its first fact", async () => {
        const vilem = (
            await createPerson({ userId: OWNER, displayName: "Vilém Brázda" })
        ).id;
        await readyRun([
            record("n1", "Veltrix", { decision: "rejected" }),
            {
                kind: "relation_phrase",
                payload: {
                    phrase: "radí",
                    subject: { personId: vilem },
                    object: { newRef: "n1" },
                    objectKind: "entity",
                    startMs: 0,
                    endMs: 10_000,
                    count: 1,
                },
                decision: "accepted",
                choice: {
                    action: "create",
                    spec: {
                        kind: "relation",
                        label: "radí",
                        subjectTypes: ["person"],
                        objectTypes: ["organization"],
                        objectKind: "entity",
                        cardinality: "many",
                    },
                },
            },
        ]);
        await finish();
        expect(await outcomes()).toEqual([
            "new_record:rejected",
            "relation_phrase:applied",
        ]);
        const types = await db()
            .select()
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.userId, OWNER));
        expect(types).toHaveLength(1);
        expect(await db().select().from(knowledgeFacts)).toEqual([]);
    });

    it("takes a record added since the run, or the one the reviewer said it is", async () => {
        const vilem = (
            await createPerson({ userId: OWNER, displayName: "Vilém Brázda" })
        ).id;
        await readyRun([
            record("n1", "Veltrix"),
            record("n2", "Vilda", {
                kind: "person",
                choice: { personId: vilem },
            }),
            worksFor({ newRef: "n2" }, { newRef: "n1" }),
        ]);
        // Added by hand while the review waited.
        const veltrix = (
            await createEntity(OWNER, {
                typeKey: "organization",
                name: "veltrix",
            })
        ).id;
        expect((await finish()).body).toMatchObject({ applied: 2 });
        expect(await outcomes()).toEqual([
            "new_record:already_exists",
            "new_record:applied",
            "fact:applied",
        ]);
        const [fact] = await db().select().from(knowledgeFacts);
        expect(fact).toMatchObject({
            subjectPersonId: vilem,
            objectEntityId: veltrix,
        });
        expect(await db().select().from(knowledgeEntities)).toHaveLength(1);
        // What Learn heard is the person's nickname from now on.
        const aliases = await db().select().from(knowledgeAliases);
        expect(
            aliases.map((alias) => [
                alias.personId,
                alias.kind,
                decryptText(alias.text),
            ]),
        ).toEqual([[vilem, "alias", "Vilda"]]);
    });

    it("keeps no misheard spelling as a nickname, and follows a record merged meanwhile", async () => {
        const veltrix = (
            await createEntity(OWNER, {
                typeKey: "organization",
                name: "Veltrix",
            })
        ).id;
        const twin = (
            await createEntity(OWNER, {
                typeKey: "organization",
                name: "Veltrix Group",
            })
        ).id;
        await readyRun([
            record("n1", "Velltrix", { choice: { entityId: veltrix } }),
            record("n2", "Kometa", { choice: { entityId: twin } }),
        ]);
        // Merged after the reviewer picked it.
        await mergeEntities(OWNER, veltrix, twin);
        await finish();
        expect(await outcomes()).toEqual([
            "new_record:applied",
            "new_record:applied",
        ]);
        // "Velltrix" is Veltrix a letter off: no nickname. "Kometa" goes to
        // the record the picked one was merged into.
        const aliases = await db().select().from(knowledgeAliases);
        expect(
            aliases.map((alias) => [alias.entityId, decryptText(alias.text)]),
        ).toEqual([[veltrix, "Kometa"]]);
    });

    it("keeps no nickname a record's own name already says", async () => {
        const vilem = (
            await createPerson({ userId: OWNER, displayName: "Vilém Brázda" })
        ).id;
        await readyRun([
            record("n1", "Vilém", {
                kind: "person",
                choice: { personId: vilem },
            }),
        ]);
        await finish();
        expect(await outcomes()).toEqual(["new_record:applied"]);
        expect(await db().select().from(knowledgeAliases)).toEqual([]);
    });

    it("refuses a record of the other kind, and what refers to it", async () => {
        const orion = (
            await createEntity(OWNER, { typeKey: "project", name: "Orion" })
        ).id;
        await readyRun([
            record("n1", "Petra Kolářová", {
                kind: "person",
                choice: { entityId: orion },
            }),
            worksFor({ newRef: "n1" }, { entityId: orion }),
        ]);
        await finish();
        expect(await outcomes()).toEqual([
            "new_record:no_longer_fits",
            "fact:record_not_added",
        ]);
    });

    it("keeps a reviewer's name and type for a new record, and bounds them", async () => {
        await readyRun([record("n1", "Veltrix")]);
        const [item] = await db().select().from(learnReviewItems);
        const send = (choice: object) =>
            patchItemRoute(
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
                            choice,
                        }),
                    },
                ),
                {
                    params: Promise.resolve({
                        id: REC,
                        itemId: item?.id ?? "",
                    }),
                },
            );
        // A thing takes a type, and is no person.
        expect((await send({ name: "Veltrix", typeKey: null })).status).toBe(
            400,
        );
        expect((await send({ personId: "anyone" })).status).toBe(400);
        expect((await send({ name: " ", typeKey: "product" })).status).toBe(
            400,
        );
        expect(
            (await send({ name: "Veltrix a.s.", typeKey: "product" })).status,
        ).toBe(200);
        await finish();
        expect(await entityNamed("Veltrix a.s.")).toMatchObject({
            typeKey: "product",
        });
        const view = (await (
            await getReviewRoute(
                new Request(`http://localhost/api/recordings/${REC}/review`, {
                    headers: { "x-test-user": OWNER },
                }),
                { params: Promise.resolve({ id: REC }) },
            )
        ).json()) as { entityTypes?: { key: string }[] };
        expect(view.entityTypes?.map((type) => type.key)).toContain("product");
        expect(view.entityTypes?.map((type) => type.key)).not.toContain(
            "person",
        );
    });

    it("adds the Organization's records on an Organization review", async () => {
        // Shared only once every speaker is answered.
        await db().insert(transcriptSpeakers).values({
            userId: OWNER,
            transcriptionId: transcriptId,
            label: "speaker_1",
            personId: null,
            source: "user",
            status: "confirmed",
            markedUnknown: true,
            confirmedByUserId: OWNER,
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
        await readyRun(
            [
                record("n1", "Veltrix"),
                record("n2", "Petra Kolářová", { kind: "person" }),
                worksFor({ newRef: "n2" }, { newRef: "n1" }),
            ],
            "org",
        );
        const finished = await finish(orgUserId, "org");
        expect(finished.body).toMatchObject({ applied: 3 });
        expect((await entityNamed("Veltrix"))?.userId).toBe(orgUserId);
        expect((await personNamed("Petra Kolářová"))?.userId).toBe(orgUserId);
    });
});
