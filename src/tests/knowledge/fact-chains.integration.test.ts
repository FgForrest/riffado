/**
 * Replacement chains of a single-valued relation, against a real
 * PostgreSQL: whatever goes (decay, a delete, a cascade, a merge), the
 * relation keeps exactly one current value, the latest one left. And
 * confirming a fact again where its evidence is under review supports it
 * again.
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
    people,
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
import {
    createEntity,
    deleteEntity,
    mergeEntities,
} from "@/lib/knowledge/entities";
import {
    confirmFactFromRecording,
    confirmManualFact,
    deleteFact,
    listFacts,
} from "@/lib/knowledge/facts";
import { changeTranscriptSpeaker } from "@/lib/knowledge/speaker-changes";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import { upsertTranscription } from "@/lib/transcription/persist";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const MARCH = "rec-march";
const JUNE = "rec-june";
const DIARIZED = "gpt-4o-transcribe-diarize";
const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 10_000,
        text: "Dobrý den, začneme.",
    },
    {
        speaker: "speaker_1",
        startMs: 10_000,
        endMs: 25_000,
        text: "Já pracuji pro firmu a vedu projekt Orion už od března.",
    },
];

describeWithDatabase("replacement chains (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let jan = "";
    let pavel = "";
    let tavesi = "";
    let acme = "";
    let gamma = "";
    let orion = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "fact_chains",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

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

    const governor = () => ({ isOrg: false, orgUserId });

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([{ id: ALICE, email: "alice@example.test" }]);
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
        tavesi = (
            await createEntity(ALICE, {
                typeKey: "organization",
                name: "Tavesi",
            })
        ).id;
        acme = (
            await createEntity(ALICE, { typeKey: "organization", name: "Acme" })
        ).id;
        gamma = (
            await createEntity(ALICE, {
                typeKey: "organization",
                name: "Gamma",
            })
        ).id;
        orion = (
            await createEntity(ALICE, { typeKey: "project", name: "Orion" })
        ).id;
        await recording(MARCH, "2026-03-03T12:04:00Z");
        await recording(JUNE, "2026-06-14T09:00:00Z");
    });

    /** Jan's `works_for` facts: which are current, and each one's pointer. */
    async function worksFor() {
        const rows = await db()
            .select({
                id: knowledgeFacts.id,
                replacedByFactId: knowledgeFacts.replacedByFactId,
            })
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.relationKey, "works_for"));
        return {
            current: rows
                .filter((row) => row.replacedByFactId === null)
                .map((row) => row.id),
            pointers: new Map(
                rows.map((row) => [row.id, row.replacedByFactId]),
            ),
        };
    }

    /** No fact is replaced by itself, and following the pointers ends. */
    function expectNoCycle(pointers: Map<string, string | null>) {
        for (const start of pointers.keys()) {
            const seen = new Set<string>();
            let at: string | null | undefined = start;
            while (at) {
                expect(seen.has(at)).toBe(false);
                seen.add(at);
                at = pointers.get(at);
            }
        }
    }

    /** Tavesi (by hand), then Acme (said in March), then Gamma (in June). */
    async function chainFromRecordings() {
        const atTavesi = await confirmManualFact(ALICE, {
            subject: { personId: jan },
            relationKey: "works_for",
            object: { entityId: tavesi },
        });
        const atAcme = await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: "works_for",
            object: { entityId: acme },
            expectedCurrentFactId: atTavesi,
            ownerUserId: ALICE,
            transcriptionId: await transcriptOf(MARCH),
            revision: await revisionOf(MARCH),
            actorUserId: ALICE,
            orgUserId,
            startMs: 10_000,
            endMs: 25_000,
        });
        const atGamma = await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: "works_for",
            object: { entityId: gamma },
            expectedCurrentFactId: atAcme,
            ownerUserId: ALICE,
            transcriptionId: await transcriptOf(JUNE),
            revision: await revisionOf(JUNE),
            actorUserId: ALICE,
            orgUserId,
            startMs: 10_000,
            endMs: 25_000,
        });
        return { atTavesi, atAcme, atGamma };
    }

    /** Tavesi, then Acme, then Gamma, all by hand. */
    async function manualChain() {
        const f1 = await confirmManualFact(ALICE, {
            subject: { personId: jan },
            relationKey: "works_for",
            object: { entityId: tavesi },
        });
        const f2 = await confirmManualFact(ALICE, {
            subject: { personId: jan },
            relationKey: "works_for",
            object: { entityId: acme },
            expectedCurrentFactId: f1,
        });
        const f3 = await confirmManualFact(ALICE, {
            subject: { personId: jan },
            relationKey: "works_for",
            object: { entityId: gamma },
            expectedCurrentFactId: f2,
        });
        return { f1, f2, f3 };
    }

    it("keeps the newest value current when the middle of a chain decays", async () => {
        const { atTavesi, atGamma } = await chainFromRecordings();

        // Retention reaps March, where only the middle value was said.
        await deleteTranscriptsForRecording(
            MARCH,
            ALICE,
            governor(),
            new Date(),
        );

        expect((await worksFor()).current).toEqual([atGamma]);
        expect(
            (await listFacts(ALICE, { personId: jan })).map((f) => f.id),
        ).toEqual([atGamma]);
        // The person replaces what they see.
        const delta = (
            await createEntity(ALICE, {
                typeKey: "organization",
                name: "Delta",
            })
        ).id;
        const atDelta = await confirmManualFact(ALICE, {
            subject: { personId: jan },
            relationKey: "works_for",
            object: { entityId: delta },
            expectedCurrentFactId: atGamma,
        });
        expect((await worksFor()).current).toEqual([atDelta]);
        // Tavesi now leads to the chain's end, not to a fact that is gone.
        const { pointers } = await worksFor();
        expect(pointers.get(atTavesi)).toBe(atGamma);
        expectNoCycle(pointers);
    });

    it("lets the previous value be current again when the newest decays", async () => {
        const { atTavesi } = await chainFromRecordings();

        await deleteTranscriptsForRecording(
            JUNE,
            ALICE,
            governor(),
            new Date(),
        );

        expect((await worksFor()).current).toEqual([
            await currentAfter(atTavesi),
        ]);
    });

    /** The fact that the chain from `id` ends at. */
    async function currentAfter(id: string): Promise<string> {
        const { pointers } = await worksFor();
        let at = id;
        for (let next = pointers.get(at); next; next = pointers.get(at)) {
            at = next;
        }
        return at;
    }

    it("keeps one current value when a fact in the middle is deleted", async () => {
        const { f1, f2, f3 } = await manualChain();

        await deleteFact(ALICE, f2);
        expect((await worksFor()).current).toEqual([f3]);

        await deleteFact(ALICE, f3);
        expect((await worksFor()).current).toEqual([f1]);
    });

    it("follows the chain, not the order of edits, when a fact in the middle goes", async () => {
        const { f1, f2, f3 } = await manualChain();
        // Tavesi was touched after Gamma was said (a note, say).
        await db()
            .update(knowledgeFacts)
            .set({ updatedAt: new Date(Date.now() + 60_000) })
            .where(eq(knowledgeFacts.id, f1));

        await deleteFact(ALICE, f2);

        expect((await worksFor()).current).toEqual([f3]);
        expect((await worksFor()).pointers.get(f1)).toBe(f3);
    });

    it("keeps one current value when the entity a middle fact names is deleted", async () => {
        const { f3 } = await manualChain();

        await deleteEntity(ALICE, acme);

        const { current, pointers } = await worksFor();
        expect(current).toEqual([f3]);
        expectNoCycle(pointers);
    });

    it("leaves no fact replaced by itself when a merge folds two values of a chain together", async () => {
        const { f1, f3 } = await manualChain();

        // Acme turns out to be Tavesi.
        await mergeEntities(ALICE, tavesi, acme);

        const { current, pointers } = await worksFor();
        expect(current).toEqual([f3]);
        expectNoCycle(pointers);
        // And once Gamma goes, Tavesi is current again.
        await deleteFact(ALICE, f3);
        expect(
            (await listFacts(ALICE, { personId: jan })).map((f) => f.id),
        ).toEqual([f1]);
    });

    it("forms no cycle when a merge folds values further apart", async () => {
        const delta = (
            await createEntity(ALICE, {
                typeKey: "organization",
                name: "Delta",
            })
        ).id;
        // Tavesi, then Acme, then Gamma, then Delta; Gamma is Tavesi.
        const { f3 } = await manualChain();
        const f4 = await confirmManualFact(ALICE, {
            subject: { personId: jan },
            relationKey: "works_for",
            object: { entityId: delta },
            expectedCurrentFactId: f3,
        });

        await mergeEntities(ALICE, tavesi, gamma);

        const { current, pointers } = await worksFor();
        expect(current).toEqual([f4]);
        expectNoCycle(pointers);
    });

    it("supports evidence under review again when the fact is confirmed again", async () => {
        const confirm = async () =>
            confirmFactFromRecording({
                subject: { personId: jan },
                relationKey: "leads",
                object: { entityId: orion },
                ownerUserId: ALICE,
                transcriptionId: await transcriptOf(MARCH),
                revision: await revisionOf(MARCH),
                actorUserId: ALICE,
                orgUserId,
                startMs: 10_000,
                endMs: 25_000,
                speakerLabel: "speaker_1",
            });
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
        const id = await confirm();
        await rename(pavel);
        await rename(jan);
        expect(
            await db()
                .select({ status: knowledgeFactEvidence.status })
                .from(knowledgeFactEvidence),
        ).toEqual([{ status: "speaker_changed" }]);

        // The person confirms the same fact over the same words again.
        expect(await confirm()).toBe(id);

        expect(
            await db()
                .select({ status: knowledgeFactEvidence.status })
                .from(knowledgeFactEvidence),
        ).toEqual([{ status: "supported" }]);
        expect(await listFacts(ALICE, { personId: jan })).toHaveLength(1);
    });
});
