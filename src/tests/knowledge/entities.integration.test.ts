/**
 * Entities and aliases against a real PostgreSQL: the two layers, merge and
 * erasure, promotion to the Organization, and the names corrections teach.
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
    knowledgeEntityNotes,
    knowledgeEntityTypes,
    people,
    transcriptCorrections,
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
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

import { db as appDb } from "@/db";
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
    promoteEntityInTx,
    renameEntity,
} from "@/lib/knowledge/entities";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import {
    createOrgType,
    createPrivateType,
    deleteOwnType,
    seedCoreVocabulary,
} from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import { upsertTranscription } from "@/lib/transcription/persist";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";
const REC = "rec-alice";

const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 5_000,
        text: "Projekt Oryon pro Senezi jede.",
    },
];

async function refusal(promise: Promise<unknown>) {
    return promise.then(
        () => null,
        (caught: unknown) =>
            caught as {
                statusCode?: number;
                code?: string;
                message?: string;
                details?: Record<string, unknown>;
            },
    );
}

describeWithDatabase("entities and aliases (PostgreSQL)", () => {
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
            "entities",
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
        await seedCoreVocabulary();
        await insertRecordings(db(), {
            id: REC,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 5_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:05Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/rec.mp3`,
            plaudVersion: "1",
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: REC,
                userId: ALICE,
                text: encryptText(TURNS[0]?.text ?? ""),
                turns: encryptJsonField(TURNS),
                detectedLanguage: "cs",
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        transcriptId = transcript?.id ?? "";
    });

    function correctOryon(entityId: string, preTicked = false) {
        return acceptCorrection({
            userId: ALICE,
            transcriptionId: transcriptId,
            revision: 0,
            anchor: { turnIndex: 0, charStart: 8, charEnd: 13, heard: "Oryon" },
            kind: "correct",
            target: { entityId },
            replacement: "Orion",
            preTicked,
            actorUserId: ALICE,
            orgUserId,
        });
    }

    describe("entities", () => {
        it("creates one in the actor's scope, stored encrypted", async () => {
            const orion = await createEntity(ALICE, {
                typeKey: "project",
                name: "  Orion ",
                description: "CRM migration",
            });
            expect(orion).toMatchObject({
                typeKey: "project",
                name: "Orion",
                description: "CRM migration",
                scope: "personal",
            });
            const [row] = await db()
                .select()
                .from(knowledgeEntities)
                .where(eq(knowledgeEntities.id, orion.id));
            expect(row?.name).not.toContain("Orion");
            expect(row?.description).not.toContain("CRM");
        });

        it("refuses a type the actor may not use, and people", async () => {
            const bobsType = await createPrivateType(BOB, {
                kind: "entity",
                label: "Supplier",
            });
            for (const typeKey of [bobsType, "no_such", "person"]) {
                expect(
                    await refusal(
                        createEntity(ALICE, { typeKey, name: "Orion" }),
                    ),
                ).toMatchObject({ statusCode: 400 });
            }
            const own = await createPrivateType(ALICE, {
                kind: "entity",
                label: "Supplier",
            });
            await createEntity(ALICE, { typeKey: own, name: "Acme" });
        });

        it("refuses a second of one name and type in a scope, naming the first", async () => {
            const orion = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion",
            });
            expect(
                await refusal(
                    createEntity(ALICE, { typeKey: "project", name: "orion" }),
                ),
            ).toMatchObject({
                statusCode: 409,
                details: { existingId: orion.id },
            });
            // Another type, another scope: no clash.
            await createEntity(ALICE, { typeKey: "product", name: "Orion" });
            await createEntity(BOB, { typeKey: "project", name: "Orion" });

            const other = await createEntity(ALICE, {
                typeKey: "project",
                name: "Tavesi",
            });
            expect(
                await refusal(renameEntity(ALICE, other.id, "ORION")),
            ).toMatchObject({ statusCode: 409 });
            await renameEntity(ALICE, other.id, "Tavesi CZ");
            expect((await getEntity(ALICE, other.id))?.name).toBe("Tavesi CZ");
        });

        it("lets everyone see the Organization's, and only its account change them", async () => {
            const tavesi = await createEntity(orgUserId, {
                typeKey: "organization",
                name: "Tavesi",
                description: "Client",
            });
            expect(
                (await listEntities(BOB)).map((entity) => entity.name),
            ).toEqual(["Tavesi"]);
            expect(
                await refusal(renameEntity(BOB, tavesi.id, "Tavesi a.s.")),
            ).toMatchObject({ statusCode: 403 });

            // A member's description is their private note.
            await describeEntity(BOB, tavesi.id, "Pays late");
            expect(await getEntity(BOB, tavesi.id)).toMatchObject({
                description: "Client",
                notes: "Pays late",
            });
            expect((await getEntity(ALICE, tavesi.id))?.notes).toBeNull();
            await describeEntity(BOB, tavesi.id, null);
            expect((await getEntity(BOB, tavesi.id))?.notes).toBeNull();
        });

        it("merges one into another, moving what names it, one hop deep", async () => {
            const orion = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion",
                description: "CRM",
            });
            const dup = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion CRM",
                description: "Migration",
            });
            const older = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion old",
            });
            await mergeEntities(ALICE, dup.id, older.id);
            await addAlias(ALICE, { entityId: dup.id }, "Orajon");
            await addAlias(ALICE, { entityId: orion.id }, "Orajon");
            await correctOryon(dup.id);

            await mergeEntities(ALICE, orion.id, dup.id);

            const [older2] = await db()
                .select({ mergedIntoId: knowledgeEntities.mergedIntoId })
                .from(knowledgeEntities)
                .where(eq(knowledgeEntities.id, older.id));
            expect(older2?.mergedIntoId).toBe(orion.id);
            expect((await getEntity(ALICE, orion.id))?.description).toBe(
                "CRM\n\nMigration",
            );
            const aliases = await listAliases(ALICE, { entityId: orion.id });
            expect(aliases.map((a) => [a.kind, a.text]).sort()).toEqual([
                ["alias", "Orajon"],
                ["heard_as", "Oryon"],
            ]);
            expect(
                (await listCorrections(ALICE, transcriptId))[0]?.targetEntityId,
            ).toBe(orion.id);
            expect(
                await refusal(
                    mergeEntities(
                        ALICE,
                        (
                            await createEntity(ALICE, {
                                typeKey: "product",
                                name: "Orion",
                            })
                        ).id,
                        orion.id,
                    ),
                ),
            ).toMatchObject({ statusCode: 409 });
        });

        it("folds a private duplicate into the Organization's, never the reverse", async () => {
            const shared = await createEntity(orgUserId, {
                typeKey: "project",
                name: "Orion",
            });
            const mine = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion (mine)",
                description: "My notes",
            });
            expect(
                await refusal(mergeEntities(orgUserId, mine.id, shared.id)),
            ).toMatchObject({ statusCode: 404 });
            await mergeEntities(ALICE, shared.id, mine.id);
            expect(await getEntity(ALICE, shared.id)).toMatchObject({
                description: null,
                notes: "My notes",
            });
        });

        it("erases one with its tombstones, and everything naming it", async () => {
            const orion = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion",
            });
            const old = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion old",
            });
            await mergeEntities(ALICE, orion.id, old.id);
            await addAlias(ALICE, { entityId: orion.id }, "Orajon");
            await correctOryon(orion.id);

            await deleteEntity(ALICE, orion.id);

            expect(await db().select().from(knowledgeEntities)).toEqual([]);
            expect(await db().select().from(knowledgeAliases)).toEqual([]);
            expect(await db().select().from(transcriptCorrections)).toEqual([]);
        });

        it("goes with its private type, counted first", async () => {
            const supplier = await createPrivateType(ALICE, {
                kind: "entity",
                label: "Supplier",
            });
            await createEntity(ALICE, { typeKey: supplier, name: "Acme" });
            expect(
                await refusal(deleteOwnType(ALICE, "entity", supplier, 0)),
            ).toMatchObject({ statusCode: 409, details: { count: 1 } });
            await deleteOwnType(ALICE, "entity", supplier, 1);
            expect(await listEntities(ALICE)).toEqual([]);
        });
    });

    describe("promotion", () => {
        function promote(entityId: string) {
            return appDb.transaction(async (tx) => {
                await lockOrgPeople(tx);
                return promoteEntityInTx(tx, entityId, orgUserId);
            });
        }

        it("hands a private entity to the Organization, its description to the owner's notes", async () => {
            const orion = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion",
                description: "Mine",
            });
            expect(await promote(orion.id)).toBe(orion.id);
            expect(await getEntity(ALICE, orion.id)).toMatchObject({
                scope: "org",
                description: null,
                notes: "Mine",
            });
            expect((await getEntity(BOB, orion.id))?.notes).toBeNull();
        });

        it("folds into the Organization's of the same name and type", async () => {
            const shared = await createEntity(orgUserId, {
                typeKey: "project",
                name: "Orion",
            });
            const mine = await createEntity(ALICE, {
                typeKey: "project",
                name: "orion",
            });
            await correctOryon(mine.id);
            expect(await promote(mine.id)).toBe(shared.id);
            expect(
                (await listCorrections(ALICE, transcriptId))[0]?.targetEntityId,
            ).toBe(shared.id);
        });

        it("takes a private type's adoption, and refuses one not adopted", async () => {
            const supplier = await createPrivateType(ALICE, {
                kind: "entity",
                label: "Supplier",
            });
            const acme = await createEntity(ALICE, {
                typeKey: supplier,
                name: "Acme",
            });
            expect(await refusal(promote(acme.id))).toMatchObject({
                statusCode: 409,
                details: { reason: "entityTypePrivate" },
            });

            // How an entity type is adopted is the vocabulary's business;
            // here only that promotion follows the adoption.
            const vendor = await createOrgType(orgUserId, {
                kind: "entity",
                label: "Vendor",
            });
            await db()
                .update(knowledgeEntityTypes)
                .set({ adoptedAsKey: vendor })
                .where(eq(knowledgeEntityTypes.key, supplier));
            expect(await promote(acme.id)).toBe(acme.id);
            expect((await getEntity(ALICE, acme.id))?.typeKey).toBe(vendor);
        });
    });

    describe("aliases", () => {
        it("keeps a nickname for an Organization person to its giver", async () => {
            const [jan] = await db()
                .insert(people)
                .values({
                    userId: orgUserId,
                    displayName: encryptText("Jan Novotný"),
                })
                .returning({ id: people.id });
            const id = await addAlias(
                ALICE,
                { personId: jan?.id ?? "" },
                "Honza",
            );
            expect(
                await refusal(
                    addAlias(ALICE, { personId: jan?.id ?? "" }, "honza"),
                ),
            ).toMatchObject({ statusCode: 409 });
            expect(
                (await listAliases(ALICE, { personId: jan?.id ?? "" })).map(
                    (a) => a.text,
                ),
            ).toEqual(["Honza"]);
            expect(await listAliases(BOB, { personId: jan?.id ?? "" })).toEqual(
                [],
            );
            expect(await refusal(removeAlias(BOB, id))).toMatchObject({
                statusCode: 404,
            });
            await removeAlias(ALICE, id);
            expect(
                await listAliases(ALICE, { personId: jan?.id ?? "" }),
            ).toEqual([]);
        });

        it("learns how a confirmed correction was heard, and forgets it with the correction", async () => {
            const orion = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion",
            });
            const id = await correctOryon(orion.id);
            expect(await listAliases(ALICE, { entityId: orion.id })).toEqual([
                expect.objectContaining({
                    kind: "heard_as",
                    text: "Oryon",
                    language: "cs",
                    provider: "openai",
                    scope: "personal",
                }),
            ]);

            await revertCorrection({
                userId: ALICE,
                transcriptionId: transcriptId,
                actorUserId: ALICE,
                orgUserId,
                correctionId: id,
            });
            expect(await listAliases(ALICE, { entityId: orion.id })).toEqual(
                [],
            );
        });

        it("learns nothing from a pre-ticked correction", async () => {
            const orion = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion",
            });
            await correctOryon(orion.id, true);
            expect(await listAliases(ALICE, { entityId: orion.id })).toEqual(
                [],
            );
        });

        it("forgets a heard-as form when a new transcript loses the correction", async () => {
            const orion = await createEntity(ALICE, {
                typeKey: "project",
                name: "Orion",
            });
            await correctOryon(orion.id);
            await upsertTranscription({
                userId: ALICE,
                recordingId: REC,
                text: "Projekt Orion pro Senezi jede.",
                detectedLanguage: "cs",
                source: "riffado",
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                turns: [
                    {
                        ...(TURNS[0] as TranscriptTurn),
                        text: "Projekt Orion pro Senezi jede.",
                    },
                ],
            });
            expect(await listCorrections(ALICE, transcriptId)).toEqual([]);
            expect(await listAliases(ALICE, { entityId: orion.id })).toEqual(
                [],
            );
        });
    });

    describe("corrections on entities", () => {
        it("answers another account's entity as a missing one", async () => {
            const bobs = await createEntity(BOB, {
                typeKey: "project",
                name: "Orion",
            });
            const missing = await refusal(correctOryon("no-such"));
            const foreign = await refusal(correctOryon(bobs.id));
            expect(missing).toMatchObject({ statusCode: 404 });
            expect(foreign).toMatchObject({
                statusCode: missing?.statusCode,
                message: missing?.message,
            });
        });

        it("goes with the notes on an entity when it is erased", async () => {
            const shared = await createEntity(orgUserId, {
                typeKey: "project",
                name: "Orion",
            });
            await describeEntity(ALICE, shared.id, "Mine");
            await deleteEntity(orgUserId, shared.id);
            expect(await db().select().from(knowledgeEntityNotes)).toEqual([]);
        });
    });
});
