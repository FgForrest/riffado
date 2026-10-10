/**
 * Merging and erasing people and entities across the knowledge tables,
 * against a real PostgreSQL: a merge moves every name, correction and fact
 * to the survivor and combines what then says the same; an erasure leaves
 * nothing naming them.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq, inArray } from "drizzle-orm";
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
    knowledgeFactEvidence,
    knowledgeFacts,
    people,
    personNotes,
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

import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addAlias, listAliases } from "@/lib/knowledge/aliases";
import { acceptCorrection } from "@/lib/knowledge/corrections";
import {
    createEntity,
    deleteEntity,
    mergeEntities,
} from "@/lib/knowledge/entities";
import {
    confirmFactFromRecording,
    confirmManualFact,
    listFacts,
} from "@/lib/knowledge/facts";
import {
    addPersonNotes,
    deletePerson,
    mergePeople,
} from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
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
        endMs: 10_000,
        text: "Tady Novák, vedu projekt Orion pro Tavesi.",
    },
];

describeWithDatabase("merge and erasure across knowledge (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let transcriptId = "";
    let orion = "";
    let tavesi = "";
    let acme = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "merge_erasure",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    async function person(userId: string, name: string): Promise<string> {
        const [row] = await db()
            .insert(people)
            .values({ userId, displayName: encryptText(name) })
            .returning({ id: people.id });
        return row?.id ?? "";
    }

    async function nameSpeaker(personId: string) {
        await db()
            .delete(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, transcriptId));
        await db().insert(transcriptSpeakers).values({
            userId: ALICE,
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId,
            source: "user",
            status: "confirmed",
            confirmedByUserId: ALICE,
        });
    }

    function leadsOrion(personId: string) {
        return confirmFactFromRecording({
            subject: { personId },
            relationKey: "leads",
            object: { entityId: orion },
            ownerUserId: ALICE,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: ALICE,
            orgUserId,
            startMs: 0,
            endMs: 10_000,
            speakerLabel: "speaker_0",
        });
    }

    function correctNovak(personId: string) {
        return acceptCorrection({
            userId: ALICE,
            transcriptionId: transcriptId,
            revision: 0,
            anchor: { turnIndex: 0, charStart: 5, charEnd: 10, heard: "Novák" },
            kind: "correct",
            target: { personId },
            replacement: "Novotný",
            actorUserId: ALICE,
            orgUserId,
        });
    }

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
            duration: 10_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:10Z"),
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
        orion = (
            await createEntity(ALICE, { typeKey: "project", name: "Orion" })
        ).id;
        tavesi = (
            await createEntity(ALICE, {
                typeKey: "organization",
                name: "Tavesi",
            })
        ).id;
        acme = (
            await createEntity(ALICE, { typeKey: "organization", name: "Acme" })
        ).id;
    });

    describe("a people merge", () => {
        it("moves names, corrections and facts to the survivor", async () => {
            const jan = await person(ALICE, "Jan Novotný");
            const honza = await person(ALICE, "Honza");
            await addAlias(ALICE, { personId: honza }, "Honzík");
            await addAlias(ALICE, { personId: honza }, "Novotný");
            await addAlias(ALICE, { personId: jan }, "Novotný");
            await correctNovak(honza);
            await nameSpeaker(honza);
            await leadsOrion(honza);

            await mergePeople(ALICE, jan, honza);

            expect(
                (await listAliases(ALICE, { personId: jan }))
                    .map((a) => a.text)
                    .sort(),
            ).toEqual(["Honzík", "Novotný", "Novák"]);
            const [correction] = await db()
                .select()
                .from(transcriptCorrections);
            expect(correction?.targetPersonId).toBe(jan);
            expect(await listFacts(ALICE, { personId: jan })).toEqual([
                expect.objectContaining({ supportedEvidence: 1 }),
            ]);
            expect(await listFacts(ALICE, { personId: honza })).toEqual([]);
        });

        it("combines two facts that then say the same, evidence and all", async () => {
            const jan = await person(ALICE, "Jan Novotný");
            const honza = await person(ALICE, "Honza");
            await nameSpeaker(honza);
            const said = await leadsOrion(honza);
            const entered = await confirmManualFact(ALICE, {
                subject: { personId: jan },
                relationKey: "leads",
                object: { entityId: orion },
            });

            await mergePeople(ALICE, jan, honza);

            const facts = await db().select().from(knowledgeFacts);
            expect(facts).toHaveLength(1);
            expect(facts[0]).toMatchObject({ id: entered, origin: "manual" });
            const evidence = await db().select().from(knowledgeFactEvidence);
            expect(evidence.map((row) => row.factId)).toEqual([entered]);
            expect(said).not.toBe(entered);
        });

        it("leaves one current fact on a single-valued relation", async () => {
            const jan = await person(ALICE, "Jan Novotný");
            const honza = await person(ALICE, "Honza");
            const atTavesi = await confirmManualFact(ALICE, {
                subject: { personId: jan },
                relationKey: "works_for",
                object: { entityId: tavesi },
            });
            const atAcme = await confirmManualFact(ALICE, {
                subject: { personId: honza },
                relationKey: "works_for",
                object: { entityId: acme },
            });

            await mergePeople(ALICE, jan, honza);

            const current = (await listFacts(ALICE, { personId: jan })).map(
                (fact) => fact.id,
            );
            expect(current).toHaveLength(1);
            expect([atTavesi, atAcme]).toContain(current[0]);
            // Both are Jan's now; the other one was replaced by it.
            const facts = await db().select().from(knowledgeFacts);
            expect(facts.map((fact) => fact.subjectPersonId)).toEqual([
                jan,
                jan,
            ]);
            expect(
                facts.find((fact) => fact.id !== current[0])?.replacedByFactId,
            ).toBe(current[0]);
        });

        it("ends a chain of merges on the last survivor, one hop from every tombstone", async () => {
            const a = await person(ALICE, "A");
            const b = await person(ALICE, "B");
            const c = await person(ALICE, "C");
            await addAlias(ALICE, { personId: a }, "Áčko");
            await confirmManualFact(ALICE, {
                subject: { personId: a },
                relationKey: "works_on",
                object: { entityId: orion },
            });
            await mergePeople(ALICE, b, a);
            await mergePeople(ALICE, c, b);

            const tombstones = await db()
                .select({ id: people.id, mergedIntoId: people.mergedIntoId })
                .from(people)
                .where(inArray(people.id, [a, b]));
            expect(tombstones.map((row) => row.mergedIntoId)).toEqual([c, c]);
            expect(
                (await listAliases(ALICE, { personId: c })).map((x) => x.text),
            ).toEqual(["Áčko"]);
            expect(await listFacts(ALICE, { personId: c })).toHaveLength(1);
        });
    });

    describe("an entity merge", () => {
        it("moves and combines facts naming the loser", async () => {
            const jan = await person(ALICE, "Jan");
            const orionCrm = (
                await createEntity(ALICE, {
                    typeKey: "project",
                    name: "Orion CRM",
                })
            ).id;
            await confirmManualFact(ALICE, {
                subject: { personId: jan },
                relationKey: "works_on",
                object: { entityId: orion },
            });
            await confirmManualFact(ALICE, {
                subject: { personId: jan },
                relationKey: "works_on",
                object: { entityId: orionCrm },
            });

            await mergeEntities(ALICE, orion, orionCrm);

            expect(await listFacts(ALICE, { entityId: orion })).toHaveLength(1);
            expect(await db().select().from(knowledgeFacts)).toHaveLength(1);
        });
    });

    describe("an erasure", () => {
        it("leaves nothing naming the person, in any scope", async () => {
            const jan = await person(orgUserId, "Jan Novotný");
            await addAlias(ALICE, { personId: jan }, "Honza");
            await addPersonNotes(jan, BOB, "Plays chess");
            await correctNovak(jan);
            await nameSpeaker(jan);
            await leadsOrion(jan);
            await confirmManualFact(ALICE, {
                subject: { personId: await person(ALICE, "Pavel") },
                relationKey: "reports_to",
                object: { personId: jan },
            });

            await deletePerson(orgUserId, jan);

            for (const table of [
                knowledgeAliases,
                personNotes,
                transcriptCorrections,
                knowledgeFacts,
                knowledgeFactEvidence,
            ]) {
                expect(await db().select().from(table)).toEqual([]);
            }
        });

        it("leaves nothing naming the entity, in any scope", async () => {
            const jan = await person(ALICE, "Jan");
            await addAlias(ALICE, { entityId: orion }, "Oryon");
            await nameSpeaker(jan);
            await leadsOrion(jan);

            await deleteEntity(ALICE, orion);

            for (const table of [
                knowledgeAliases,
                knowledgeFacts,
                knowledgeFactEvidence,
            ]) {
                expect(await db().select().from(table)).toEqual([]);
            }
        });
    });
});
