/**
 * Facts and their evidence against a real PostgreSQL, following the
 * design's "Life of one fact" where it needs neither sharing nor Learn:
 * confirmed from a recording, carried over re-transcription, put to review
 * by new wording or a renamed speaker, strengthened by a second recording,
 * and decaying as retention reaps their transcripts.
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
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    people,
    recordings,
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
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

import { deleteTranscriptsForRecording } from "@/db/queries/retention";
import { encryptText } from "@/lib/encryption/fields";
import { createEntity } from "@/lib/knowledge/entities";
import {
    confirmFactFromRecording,
    confirmManualFact,
    deleteFact,
    type FactArgs,
    listFacts,
    withdrawEvidence,
} from "@/lib/knowledge/facts";
import { deletePerson } from "@/lib/knowledge/people";
import { changeTranscriptSpeaker } from "@/lib/knowledge/speaker-changes";
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
const MARCH = "rec-march";
const JUNE = "rec-june";
const DIARIZED = "gpt-4o-transcribe-diarize";

const SAID = "Já vedu projekt Orion pro Tavesi už od března.";
const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 10_000,
        text: "Dobrý den, začneme.",
    },
    { speaker: "speaker_1", startMs: 10_000, endMs: 25_000, text: SAID },
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

describeWithDatabase("facts and evidence (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let jan = "";
    let pavel = "";
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
            "facts",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    async function recording(id: string, startTime: string) {
        await insertRecordings(db(), {
            id,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText("Weekly"),
            duration: 25_000,
            startTime: new Date(startTime),
            endTime: new Date(startTime),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/${id}.mp3`,
            plaudVersion: "1",
        });
        await write(id, TURNS);
        await db()
            .insert(transcriptSpeakers)
            .values({
                userId: ALICE,
                transcriptionId: await transcriptOf(id),
                label: "speaker_1",
                personId: jan,
                source: "user",
                status: "confirmed",
                confirmedByUserId: ALICE,
            });
    }

    function write(recordingId: string, turns: TranscriptTurn[]) {
        return upsertTranscription({
            userId: ALICE,
            recordingId,
            text: turns.map((turn) => turn.text).join("\n"),
            detectedLanguage: "cs",
            source: "riffado",
            provider: "openai",
            model: DIARIZED,
            turns,
        });
    }

    async function transcriptOf(recordingId: string): Promise<string> {
        const [row] = await db()
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, recordingId));
        return row?.id ?? "";
    }

    async function revisionOf(recordingId: string): Promise<number> {
        const [row] = await db()
            .select({ revision: transcriptions.revision })
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, recordingId));
        return row?.revision ?? -1;
    }

    const janLeadsOrion: FactArgs = {
        subject: { personId: "" },
        relationKey: "leads",
        object: { entityId: "" },
    };

    async function confirmFrom(
        recordingId: string,
        overrides: Partial<Parameters<typeof confirmFactFromRecording>[0]> = {},
    ) {
        return confirmFactFromRecording({
            ...janLeadsOrion,
            subject: { personId: jan },
            object: { entityId: orion },
            ownerUserId: ALICE,
            transcriptionId: await transcriptOf(recordingId),
            revision: await revisionOf(recordingId),
            actorUserId: ALICE,
            orgUserId,
            startMs: 10_000,
            endMs: 25_000,
            speakerLabel: "speaker_1",
            ...overrides,
        });
    }

    async function evidence() {
        return db()
            .select({
                status: knowledgeFactEvidence.status,
                speakerLabel: knowledgeFactEvidence.speakerLabel,
                transcriptRevision: knowledgeFactEvidence.transcriptRevision,
                quote: knowledgeFactEvidence.quote,
            })
            .from(knowledgeFactEvidence);
    }

    const governor = () => ({ isOrg: false, orgUserId });

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
        const inserted = await db()
            .insert(people)
            .values([
                { userId: ALICE, displayName: encryptText("Jan Novotný") },
                { userId: ALICE, displayName: encryptText("Pavel") },
            ])
            .returning({ id: people.id });
        jan = inserted[0]?.id ?? "";
        pavel = inserted[1]?.id ?? "";
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
        await recording(MARCH, "2026-03-03T12:04:00Z");
    });

    describe("the life of one fact", () => {
        it("is confirmed from a recording, with the words said there", async () => {
            const id = await confirmFrom(MARCH);
            expect(await listFacts(ALICE, { personId: jan })).toEqual([
                expect.objectContaining({
                    id,
                    scope: "personal",
                    relationKey: "leads",
                    object: { entityId: orion },
                    origin: "recording",
                    supportedEvidence: 1,
                    lastSaidAt: new Date("2026-03-03T12:04:00Z"),
                }),
            ]);
            const [row] = await evidence();
            expect(row?.status).toBe("supported");
            expect(row?.quote).not.toContain("Orion");
        });

        it("survives a re-transcription that numbers the voices differently", async () => {
            await confirmFrom(MARCH);
            await write(MARCH, [
                { ...(TURNS[0] as TranscriptTurn), speaker: "speaker_1" },
                { ...(TURNS[1] as TranscriptTurn), speaker: "speaker_0" },
            ]);
            expect(await evidence()).toEqual([
                expect.objectContaining({
                    status: "supported",
                    speakerLabel: "speaker_0",
                    transcriptRevision: await revisionOf(MARCH),
                }),
            ]);
            expect(await listFacts(ALICE, { personId: jan })).toHaveLength(1);
        });

        it("goes to review, not away, when the words at its time change", async () => {
            await confirmFrom(MARCH);
            await write(MARCH, [
                TURNS[0] as TranscriptTurn,
                {
                    ...(TURNS[1] as TranscriptTurn),
                    text: "Zítra bude pršet a vezmu si deštník.",
                },
            ]);
            expect((await evidence())[0]?.status).toBe("wording_changed");
            expect(await listFacts(ALICE, { personId: jan })).toEqual([]);
            expect(await db().select().from(knowledgeFacts)).toHaveLength(1);
        });

        it("on a transcript without times, stays through an unchanged re-import and goes to review on any change", async () => {
            const untimed = TURNS.map((turn) => ({
                ...turn,
                startMs: 0,
                endMs: 0,
            }));
            await write(MARCH, untimed);
            await confirmFrom(MARCH, {
                startMs: 0,
                endMs: 0,
                speakerLabel: null,
            });
            await write(MARCH, untimed);
            expect((await evidence())[0]?.status).toBe("supported");
            // One word elsewhere: the quote, the whole transcript, is still
            // alike, but nothing says the fact's own words stayed.
            await write(MARCH, [
                {
                    ...(untimed[0] as TranscriptTurn),
                    text: "Dobrý den, začneme hned.",
                },
                untimed[1] as TranscriptTurn,
            ]);
            expect((await evidence())[0]?.status).toBe("wording_changed");
        });

        it("on a transcript without times, keeps evidence that depends on its speaker through an unchanged re-import", async () => {
            const untimed = TURNS.map((turn) => ({
                ...turn,
                startMs: 0,
                endMs: 0,
            }));
            await write(MARCH, untimed);
            // The rewrite could not carry the answer without times; say it
            // again, on the untimed transcript.
            await db()
                .delete(transcriptSpeakers)
                .where(
                    eq(
                        transcriptSpeakers.transcriptionId,
                        await transcriptOf(MARCH),
                    ),
                );
            await db()
                .insert(transcriptSpeakers)
                .values({
                    userId: ALICE,
                    transcriptionId: await transcriptOf(MARCH),
                    label: "speaker_1",
                    personId: jan,
                    source: "user",
                    status: "confirmed",
                    confirmedByUserId: ALICE,
                });
            await confirmFrom(MARCH, { startMs: 0, endMs: 0 });
            await write(MARCH, untimed);
            expect(await evidence()).toEqual([
                expect.objectContaining({
                    status: "supported",
                    speakerLabel: "speaker_1",
                }),
            ]);
            // The name stays confirmed, not a suggestion again.
            expect(
                await db()
                    .select({
                        label: transcriptSpeakers.label,
                        personId: transcriptSpeakers.personId,
                        status: transcriptSpeakers.status,
                    })
                    .from(transcriptSpeakers),
            ).toEqual([
                { label: "speaker_1", personId: jan, status: "confirmed" },
            ]);
        });

        it("goes to review when its speaker is renamed, and only then", async () => {
            await confirmFrom(MARCH);
            const rename = async (personId: string) =>
                changeTranscriptSpeaker({
                    userId: ALICE,
                    transcriptionId: await transcriptOf(MARCH),
                    revision: await revisionOf(MARCH),
                    label: "speaker_1",
                    answer: { kind: "name", personId },
                    actorUserId: ALICE,
                    orgUserId,
                });
            await rename(jan);
            expect((await evidence())[0]?.status).toBe("supported");
            await rename(pavel);
            expect((await evidence())[0]?.status).toBe("speaker_changed");
            expect(await listFacts(ALICE, { personId: jan })).toEqual([]);
        });

        it("counts only where it was said on recordings the viewer can open", async () => {
            await confirmFrom(MARCH);
            await recording(JUNE, "2026-06-14T09:00:00Z");
            await confirmFrom(JUNE);
            await db()
                .update(recordings)
                .set({ deletedAt: new Date() })
                .where(eq(recordings.id, JUNE));
            expect(await listFacts(ALICE, { personId: jan })).toEqual([
                expect.objectContaining({
                    supportedEvidence: 1,
                    lastSaidAt: new Date("2026-03-03T12:04:00Z"),
                }),
            ]);
        });

        it("is strengthened by a second recording, and decays as retention reaps them", async () => {
            await confirmFrom(MARCH);
            await recording(JUNE, "2026-06-14T09:00:00Z");
            await confirmFrom(JUNE);
            expect(await listFacts(ALICE, { personId: jan })).toEqual([
                expect.objectContaining({
                    supportedEvidence: 2,
                    lastSaidAt: new Date("2026-06-14T09:00:00Z"),
                }),
            ]);

            await deleteTranscriptsForRecording(
                MARCH,
                ALICE,
                governor(),
                new Date(),
            );
            expect(await listFacts(ALICE, { personId: jan })).toEqual([
                expect.objectContaining({ supportedEvidence: 1 }),
            ]);

            await deleteTranscriptsForRecording(
                JUNE,
                ALICE,
                governor(),
                new Date(),
            );
            expect(await db().select().from(knowledgeFacts)).toEqual([]);
        });

        it("goes when its last evidence is dropped, unless someone entered it by hand", async () => {
            const id = await confirmFrom(MARCH);
            const [row] = await db()
                .select({ id: knowledgeFactEvidence.id })
                .from(knowledgeFactEvidence);
            const drop = async () =>
                withdrawEvidence({
                    ownerUserId: ALICE,
                    transcriptionId: await transcriptOf(MARCH),
                    evidenceId: row?.id ?? "",
                    actorUserId: ALICE,
                    orgUserId,
                });
            await confirmManualFact(ALICE, {
                ...janLeadsOrion,
                subject: { personId: jan },
                object: { entityId: orion },
            });
            await drop();
            expect(await listFacts(ALICE, { personId: jan })).toEqual([
                expect.objectContaining({ id, origin: "manual" }),
            ]);

            await deleteFact(ALICE, id);
            await confirmFrom(MARCH);
            const [again] = await db()
                .select({ id: knowledgeFactEvidence.id })
                .from(knowledgeFactEvidence);
            await withdrawEvidence({
                ownerUserId: ALICE,
                transcriptionId: await transcriptOf(MARCH),
                evidenceId: again?.id ?? "",
                actorUserId: ALICE,
                orgUserId,
            });
            expect(await db().select().from(knowledgeFacts)).toEqual([]);
        });
    });

    describe("single-valued relations", () => {
        const worksFor = (entityId: string, expected?: string | null) =>
            confirmManualFact(ALICE, {
                subject: { personId: jan },
                relationKey: "works_for",
                object: { entityId },
                expectedCurrentFactId: expected,
            });

        it("replace the current fact the person saw, and refuse one they did not", async () => {
            const atTavesi = await worksFor(tavesi);
            expect(await refusal(worksFor(acme))).toMatchObject({
                statusCode: 409,
                details: { currentFactId: atTavesi },
            });
            const atAcme = await worksFor(acme, atTavesi);
            expect(
                (await listFacts(ALICE, { personId: jan })).map((f) => f.id),
            ).toEqual([atAcme]);

            // Back to Tavesi: the old fact is current again.
            expect(await worksFor(tavesi, atAcme)).toBe(atTavesi);
            expect(
                (await listFacts(ALICE, { personId: jan })).map((f) => f.id),
            ).toEqual([atTavesi]);
            // Confirming the current one again changes nothing.
            expect(await worksFor(tavesi, null)).toBe(atTavesi);
        });

        it("fall back to the one replaced when the replacement decays", async () => {
            const atTavesi = await worksFor(tavesi);
            const atAcme = await confirmFrom(MARCH, {
                relationKey: "works_for",
                object: { entityId: acme },
                expectedCurrentFactId: atTavesi,
            });
            expect(
                (await listFacts(ALICE, { personId: jan })).map((f) => f.id),
            ).toEqual([atAcme]);
            await deleteTranscriptsForRecording(
                MARCH,
                ALICE,
                governor(),
                new Date(),
            );
            expect(
                (await listFacts(ALICE, { personId: jan })).map((f) => f.id),
            ).toEqual([atTavesi]);
        });
    });

    describe("what a fact may say", () => {
        it("refuses a relation that does not fit, or is unknown", async () => {
            for (const args of [
                { relationKey: "leads", object: { personId: pavel } },
                { relationKey: "no_such", object: { entityId: orion } },
                { relationKey: "has_role", object: { entityId: orion } },
            ]) {
                expect(
                    await refusal(
                        confirmManualFact(ALICE, {
                            subject: { personId: jan },
                            ...args,
                        }),
                    ),
                ).toMatchObject({ statusCode: 400 });
            }
            await confirmManualFact(ALICE, {
                subject: { personId: jan },
                relationKey: "has_role",
                object: { literal: " CTO " },
            });
            expect(await listFacts(ALICE, { personId: jan })).toEqual([
                expect.objectContaining({ object: { literal: "CTO" } }),
            ]);
        });

        it("refuses evidence that does not hold", async () => {
            expect(
                await refusal(
                    confirmFrom(MARCH, { speakerLabel: "speaker_0" }),
                ),
            ).toMatchObject({
                statusCode: 400,
                details: { field: "speakerLabel" },
            });
            expect(
                await refusal(
                    confirmFrom(MARCH, { startMs: 60_000, endMs: 70_000 }),
                ),
            ).toMatchObject({ statusCode: 400 });
            expect(
                await refusal(
                    confirmFrom(MARCH, {
                        revision: (await revisionOf(MARCH)) - 1,
                    }),
                ),
            ).toMatchObject({ statusCode: 409 });
            expect(
                await refusal(confirmFrom(MARCH, { actorUserId: BOB })),
            ).toMatchObject({ statusCode: 404 });
            expect(await db().select().from(knowledgeFacts)).toEqual([]);
        });

        it("uses the Organization's relation for a private one it adopted", async () => {
            const mentors = await createPrivateType(ALICE, {
                kind: "relation",
                label: "mentors",
                subjectTypes: ["person"],
                objectTypes: ["person"],
                objectKind: "entity",
                cardinality: "many",
            });
            const shared = await createOrgType(orgUserId, {
                kind: "relation",
                label: "mentors",
                subjectTypes: ["person"],
                objectTypes: ["person"],
                objectKind: "entity",
                cardinality: "many",
            });
            await db()
                .update(knowledgeRelationTypes)
                .set({ adoptedAsKey: shared })
                .where(eq(knowledgeRelationTypes.key, mentors));
            await confirmManualFact(ALICE, {
                subject: { personId: jan },
                relationKey: mentors,
                object: { personId: pavel },
            });
            expect(
                (await listFacts(ALICE, { personId: jan }))[0]?.relationKey,
            ).toBe(shared);
        });

        it("goes with its relation type, counted first, and with its person", async () => {
            const mentors = await createPrivateType(ALICE, {
                kind: "relation",
                label: "mentors",
                subjectTypes: ["person"],
                objectTypes: ["person"],
                objectKind: "entity",
                cardinality: "many",
            });
            await confirmManualFact(ALICE, {
                subject: { personId: jan },
                relationKey: mentors,
                object: { personId: pavel },
            });
            expect(
                await refusal(deleteOwnType(ALICE, "relation", mentors, 0)),
            ).toMatchObject({ statusCode: 409, details: { count: 1 } });
            await deleteOwnType(ALICE, "relation", mentors, 1);
            expect(await db().select().from(knowledgeFacts)).toEqual([]);

            await confirmFrom(MARCH);
            await deletePerson(ALICE, jan);
            expect(await db().select().from(knowledgeFacts)).toEqual([]);
            expect(await db().select().from(knowledgeFactEvidence)).toEqual([]);
        });
    });
});
