/**
 * What one account's private knowledge reveals to another, against a real
 * PostgreSQL: nothing. User B must learn nothing about A's private layer
 * through ids, lists, search, counts, vocabulary, vectors or review items,
 * nor through merge targets, uniqueness errors or error messages.
 *
 * Grows with every knowledge table (plan, Phase 2 conventions).
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

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
    knowledgeEntityTypes,
    knowledgeRelationTypes,
    knowledgeVocabularyProposals,
    people,
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
            KNOWLEDGE_MEMORY_MB: 64,
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

import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addAlias, listAliases, removeAlias } from "@/lib/knowledge/aliases";
import {
    acceptCorrection,
    listCorrections,
    revertCorrection,
} from "@/lib/knowledge/corrections";
import {
    createEntity,
    deleteEntity,
    describeEntity,
    getEntity,
    listEntities,
    mergeEntities,
    renameEntity,
} from "@/lib/knowledge/entities";
import {
    confirmManualFact,
    deleteFact,
    listFacts,
} from "@/lib/knowledge/facts";
import {
    findByName,
    knowledgeStore,
    knowledgeView,
} from "@/lib/knowledge/knowledge-loader";
import { mergePeople } from "@/lib/knowledge/people";
import {
    createPrivateType,
    deleteOwnType,
    listVocabularyProposals,
    proposePhrase,
    renameOwnType,
    seedCoreVocabulary,
    vocabularyVisibleTo,
} from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

const worksWith = {
    kind: "relation" as const,
    label: "mentors",
    subjectTypes: ["person"],
    objectTypes: ["person"],
    objectKind: "entity" as const,
    cardinality: "many" as const,
};

async function refusal(promise: Promise<unknown>) {
    return promise.then(
        () => null,
        (caught: unknown) =>
            caught as { statusCode?: number; code?: string; message?: string },
    );
}

/** The same answer, to the letter, as for something that does not exist. */
function expectSameRefusal(
    error: Awaited<ReturnType<typeof refusal>>,
    missing: Awaited<ReturnType<typeof refusal>>,
) {
    expect(missing).not.toBeNull();
    expect(error).toMatchObject({
        statusCode: missing?.statusCode,
        code: missing?.code,
        message: missing?.message,
    });
}

describeWithDatabase("private knowledge stays private (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "leakage",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(knowledgeVocabularyProposals);
        await db().delete(knowledgeRelationTypes);
        await db().delete(knowledgeEntityTypes);
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await seedCoreVocabulary();
    });

    describe("vocabulary", () => {
        it("lists no other account's private types, to anyone", async () => {
            const key = await createPrivateType(ALICE, worksWith);
            for (const viewer of [BOB, orgUserId]) {
                const { relationTypes } = await vocabularyVisibleTo(viewer);
                expect(relationTypes.some((r) => r.key === key)).toBe(false);
                expect(relationTypes.some((r) => r.label === "mentors")).toBe(
                    false,
                );
            }
        });

        it("answers a change to another account's type as to a missing one", async () => {
            const key = await createPrivateType(ALICE, worksWith);
            const missing = await refusal(
                renameOwnType(BOB, "relation", "u_missing", "x"),
            );
            for (const attempt of [
                () => renameOwnType(BOB, "relation", key, "x"),
                () => deleteOwnType(BOB, "relation", key, 0),
                () => renameOwnType(orgUserId, "relation", key, "x"),
            ]) {
                const error = await refusal(attempt());
                expect(error).toMatchObject({
                    statusCode: (missing as { statusCode?: number }).statusCode,
                    code: (missing as { code?: string }).code,
                });
                expect((error as Error).message).toBe(
                    (missing as Error).message,
                );
            }
        });

        it("never refuses a name because another account uses it", async () => {
            await createPrivateType(ALICE, worksWith);
            await expect(createPrivateType(BOB, worksWith)).resolves.toMatch(
                /^u_/,
            );
        });

        it("shows suggested phrases only to the organization account, without who suggested them", async () => {
            await proposePhrase(ALICE, "mentors");
            expect(await refusal(listVocabularyProposals(BOB))).toMatchObject({
                statusCode: 403,
            });
            const proposals = await listVocabularyProposals(orgUserId);
            expect(proposals).toHaveLength(1);
            expect(JSON.stringify(proposals)).not.toContain(ALICE);
        });
    });

    describe("corrections", () => {
        const TURNS = [
            {
                speaker: "speaker_0",
                startMs: 0,
                endMs: 4_000,
                text: "Tady Novák z Orionu.",
            },
        ];
        const anchor = {
            turnIndex: 0,
            charStart: 5,
            charEnd: 10,
            heard: "Novák",
        };

        /** A recording of `userId`'s with one timed transcript, and a person. */
        async function seed(userId: string) {
            await insertRecordings(db(), {
                id: `rec-${userId}`,
                userId,
                deviceSn: "SN-1",
                plaudFileId: `plaud-${userId}`,
                filename: encryptText("Weekly"),
                duration: 4_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:00:04Z"),
                filesize: 11,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${userId}/rec.mp3`,
                plaudVersion: "1",
            });
            const [transcript] = await db()
                .insert(transcriptions)
                .values({
                    recordingId: `rec-${userId}`,
                    userId,
                    text: encryptText(TURNS[0]?.text ?? ""),
                    turns: encryptJsonField(TURNS),
                    provider: "openai",
                    model: "gpt-4o-transcribe-diarize",
                    source: "riffado",
                })
                .returning({
                    id: transcriptions.id,
                    revision: transcriptions.revision,
                });
            const [person] = await db()
                .insert(people)
                .values({ userId, displayName: encryptText("Jan Novotný") })
                .returning({ id: people.id });
            return {
                transcriptionId: transcript?.id ?? "",
                revision: transcript?.revision ?? 0,
                personId: person?.id ?? "",
            };
        }

        function accept(
            userId: string,
            seeded: Awaited<ReturnType<typeof seed>>,
            targetPersonId = seeded.personId,
        ) {
            return acceptCorrection({
                userId,
                transcriptionId: seeded.transcriptionId,
                revision: seeded.revision,
                anchor,
                kind: "correct",
                target: { personId: targetPersonId },
                replacement: "Novotný",
                actorUserId: userId,
                orgUserId,
            });
        }

        it("lists none of another account's corrections", async () => {
            const alice = await seed(ALICE);
            await accept(ALICE, alice);
            expect(await listCorrections(BOB, alice.transcriptionId)).toEqual(
                [],
            );
        });

        it("answers another account's correction as a missing one", async () => {
            const alice = await seed(ALICE);
            const bob = await seed(BOB);
            const id = await accept(ALICE, alice);
            const revert = (correctionId: string) =>
                revertCorrection({
                    userId: BOB,
                    transcriptionId: bob.transcriptionId,
                    actorUserId: BOB,
                    orgUserId,
                    correctionId,
                });
            expectSameRefusal(
                await refusal(revert(id)),
                await refusal(revert("no-such")),
            );
            expect(
                await listCorrections(ALICE, alice.transcriptionId),
            ).toHaveLength(1);
        });

        it("answers another account's person as a missing one", async () => {
            const alice = await seed(ALICE);
            const bob = await seed(BOB);
            expectSameRefusal(
                await refusal(accept(BOB, bob, alice.personId)),
                await refusal(accept(BOB, bob, "no-such")),
            );
        });
    });

    describe("entities and aliases", () => {
        it("lists none of another account's entities, nor their names", async () => {
            const orion = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion",
            });
            await addAlias(ALICE, { entityId: orion.id }, "Orajon");
            for (const viewer of [BOB, orgUserId]) {
                expect(await listEntities(viewer)).toEqual([]);
                expect(await getEntity(viewer, orion.id)).toBeNull();
                expect(
                    await listAliases(viewer, { entityId: orion.id }),
                ).toEqual([]);
            }
        });

        it("answers every change to another account's entity as to a missing one", async () => {
            const orion = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion",
            });
            const bobs = await createEntity(BOB, {
                typeKey: "project",
                name: "Orion (Bob)",
            });
            const changes = (id: string) => [
                () => renameEntity(BOB, id, "x"),
                () => describeEntity(BOB, id, "x"),
                () => deleteEntity(BOB, id),
                () => mergeEntities(BOB, bobs.id, id),
                () => mergeEntities(BOB, id, bobs.id),
                () => addAlias(BOB, { entityId: id }, "x"),
            ];
            const missing = changes("no-such");
            for (const [index, change] of changes(orion.id).entries()) {
                expectSameRefusal(
                    await refusal(change()),
                    await refusal((missing[index] as () => Promise<unknown>)()),
                );
            }
            expect((await getEntity(ALICE, orion.id))?.name).toBe("Orion");
        });

        it("never refuses an entity's name because another account uses it", async () => {
            await createEntity(ALICE, { typeKey: "project", name: "Orion" });
            await expect(
                createEntity(BOB, { typeKey: "project", name: "Orion" }),
            ).resolves.toMatchObject({ name: "Orion" });
        });

        it("answers an alias on another account's person, or their alias, as missing", async () => {
            const [alicesJan] = await db()
                .insert(people)
                .values({ userId: ALICE, displayName: encryptText("Jan") })
                .returning({ id: people.id });
            const aliasId = await addAlias(
                ALICE,
                { personId: alicesJan?.id ?? "" },
                "Honza",
            );
            expectSameRefusal(
                await refusal(
                    addAlias(BOB, { personId: alicesJan?.id ?? "" }, "Honza"),
                ),
                await refusal(addAlias(BOB, { personId: "no-such" }, "Honza")),
            );
            expectSameRefusal(
                await refusal(removeAlias(BOB, aliasId)),
                await refusal(removeAlias(BOB, "no-such")),
            );
        });
    });

    describe("facts", () => {
        async function aliceWithFact() {
            const [jan, pavel] = await db()
                .insert(people)
                .values([
                    { userId: ALICE, displayName: encryptText("Jan") },
                    { userId: ALICE, displayName: encryptText("Pavel") },
                ])
                .returning({ id: people.id });
            const factId = await confirmManualFact(ALICE, {
                subject: { personId: jan?.id ?? "" },
                relationKey: "reports_to",
                object: { personId: pavel?.id ?? "" },
            });
            return { jan: jan?.id ?? "", pavel: pavel?.id ?? "", factId };
        }

        it("lists none of another account's facts", async () => {
            const { jan } = await aliceWithFact();
            for (const viewer of [BOB, orgUserId]) {
                expect(await listFacts(viewer, { personId: jan })).toEqual([]);
            }
        });

        it("answers a fact about another account's person, or their fact, as missing", async () => {
            const { jan, pavel, factId } = await aliceWithFact();
            const [bobs] = await db()
                .insert(people)
                .values({ userId: BOB, displayName: encryptText("Petr") })
                .returning({ id: people.id });
            const state = (subject: string, object: string) =>
                confirmManualFact(BOB, {
                    subject: { personId: subject },
                    relationKey: "reports_to",
                    object: { personId: object },
                });
            expectSameRefusal(
                await refusal(state(jan, bobs?.id ?? "")),
                await refusal(state("no-such", bobs?.id ?? "")),
            );
            expectSameRefusal(
                await refusal(state(bobs?.id ?? "", pavel)),
                await refusal(state(bobs?.id ?? "", "no-such")),
            );
            expectSameRefusal(
                await refusal(deleteFact(BOB, factId)),
                await refusal(deleteFact(BOB, "no-such")),
            );
            expect(await listFacts(ALICE, { personId: jan })).toHaveLength(1);
        });
    });

    describe("what a reader is given", () => {
        /** Alice's private knowledge, some of it about the Organization's Jan. */
        async function alicesPrivateLayer() {
            knowledgeStore().invalidateAll();
            const [orgJan, alicesPavel] = await db()
                .insert(people)
                .values([
                    { userId: orgUserId, displayName: encryptText("Jan") },
                    { userId: ALICE, displayName: encryptText("Pavel Tajný") },
                ])
                .returning({ id: people.id });
            const orion = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion Secret",
            });
            await addAlias(ALICE, { personId: orgJan?.id ?? "" }, "Honzíček");
            await confirmManualFact(ALICE, {
                subject: { personId: orgJan?.id ?? "" },
                relationKey: "leads",
                object: { entityId: orion.id },
            });
            return {
                orgJan: orgJan?.id ?? "",
                alicesPavel: alicesPavel?.id ?? "",
                orion: orion.id,
            };
        }

        it("gives no one else, nor a shared run, anything of it: not by search, list or count", async () => {
            const { orgJan } = await alicesPrivateLayer();
            for (const context of [
                { kind: "pages" as const, viewerUserId: BOB },
                { kind: "pages" as const, viewerUserId: orgUserId },
                {
                    kind: "recording" as const,
                    ownerUserId: ALICE,
                    shared: true,
                },
            ]) {
                const view = await knowledgeView(context);
                const text = JSON.stringify({
                    items: view.items,
                    facts: view.facts,
                });
                for (const secret of [
                    "Pavel Tajný",
                    "Orion Secret",
                    "Honzíček",
                ]) {
                    expect(text).not.toContain(secret);
                    expect(findByName(view, secret)).toEqual([]);
                }
                expect(view.facts).toEqual([]);
            }
            for (const viewer of [BOB, orgUserId]) {
                expect(await listFacts(viewer, { personId: orgJan })).toEqual(
                    [],
                );
                expect(await listAliases(viewer, { personId: orgJan })).toEqual(
                    [],
                );
            }
        });

        it("answers a merge into or of another account's person as missing", async () => {
            const { alicesPavel } = await alicesPrivateLayer();
            const [bobs] = await db()
                .insert(people)
                .values({ userId: BOB, displayName: encryptText("Petr") })
                .returning({ id: people.id });
            const bobsId = bobs?.id ?? "";
            expectSameRefusal(
                await refusal(mergePeople(BOB, alicesPavel, bobsId)),
                await refusal(mergePeople(BOB, "no-such", bobsId)),
            );
            expectSameRefusal(
                await refusal(mergePeople(BOB, bobsId, alicesPavel)),
                await refusal(mergePeople(BOB, bobsId, "no-such")),
            );
        });

        it("never refuses a name because another account gave it", async () => {
            const { orgJan } = await alicesPrivateLayer();
            await expect(
                addAlias(BOB, { personId: orgJan }, "Honzíček"),
            ).resolves.toEqual(expect.any(String));
        });
    });
});
