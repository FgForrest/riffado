/**
 * Knowledge through sharing and withdrawal, against a real PostgreSQL: a
 * share publishes the owner's corrections, heard-as forms and facts on the
 * recording to the Organization (promoting who and what they name), keeps
 * what cannot be shared private, and a withdrawal takes back the
 * Organization's evidence while the owner gets the corrections back.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
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
    knowledgeAliases,
    knowledgeEntities,
    knowledgeEntityTypes,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    people,
    recordingFolders,
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

import {
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import type { ArchiveScope } from "@/lib/export/archive-scope";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import { acceptCorrection } from "@/lib/knowledge/corrections";
import { createEntity } from "@/lib/knowledge/entities";
import {
    confirmFactFromRecording,
    confirmManualFact,
} from "@/lib/knowledge/facts";
import {
    createOrgType,
    createPrivateType,
    deleteOwnType,
    seedCoreVocabulary,
} from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import type { StorageProvider } from "@/lib/storage/types";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const REC = "rec-shared";

const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 12_000,
        text: "Tady Novák, vedu Orion a zítra volám Akme a Honzovi.",
    },
];
const at = (heard: string) => {
    const charStart = TURNS[0]?.text.indexOf(heard) ?? -1;
    return {
        turnIndex: 0,
        charStart,
        charEnd: charStart + heard.length,
        heard,
    };
};

describeWithDatabase("knowledge through sharing (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let transcriptId = "";
    let jan = "";
    let pavel = "";
    let orion = "";
    let acme = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "share_knowledge",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

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

    function correct(
        heard: string,
        target: { personId: string } | { entityId: string },
        actorUserId = OWNER,
        replacement = "X",
    ) {
        return acceptCorrection({
            userId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            anchor: at(heard),
            kind: "correct",
            target,
            replacement,
            actorUserId,
            orgUserId,
        });
    }

    const scopeOf = async (id: string) =>
        (
            await db()
                .select({ userId: transcriptCorrections.userId })
                .from(transcriptCorrections)
                .where(eq(transcriptCorrections.id, id))
        )[0]?.userId;

    beforeEach(async () => {
        await db().delete(users);
        await db().insert(users).values({ id: OWNER, email: "o@example.test" });
        orgUserId = (await ensureOrgAccount()) ?? "";
        await seedCoreVocabulary();
        await insertRecordings(db(), {
            id: REC,
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 12_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:12Z"),
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
                detectedLanguage: "cs",
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        transcriptId = transcript?.id ?? "";
        const inserted = await db()
            .insert(people)
            .values([
                { userId: OWNER, displayName: encryptText("Jan Novotný") },
                { userId: OWNER, displayName: encryptText("Pavel") },
            ])
            .returning({ id: people.id });
        jan = inserted[0]?.id ?? "";
        pavel = inserted[1]?.id ?? "";
        await db().insert(transcriptSpeakers).values({
            userId: OWNER,
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: jan,
            source: "user",
            status: "confirmed",
            confirmedByUserId: OWNER,
        });
        orion = (
            await createEntity(OWNER, { typeKey: "project", name: "Orion" })
        ).id;
        const supplier = await createPrivateType(OWNER, {
            kind: "entity",
            label: "Supplier",
        });
        acme = (await createEntity(OWNER, { typeKey: supplier, name: "Acme" }))
            .id;
    });

    const owners = async (
        table: typeof people | typeof knowledgeEntities,
        id: string,
    ) =>
        (
            await db()
                .select({ userId: table.userId })
                .from(table)
                .where(eq(table.id, id))
        )[0]?.userId;

    /** The Organization's own types, as the curator would list them. */
    const orgTypes = async () => [
        ...(
            await db()
                .select({
                    label: knowledgeEntityTypes.label,
                    fromShare: knowledgeEntityTypes.adoptedFromShare,
                })
                .from(knowledgeEntityTypes)
                .where(eq(knowledgeEntityTypes.userId, orgUserId))
        ).map((row) => ({
            kind: "entity" as const,
            label: decryptText(row.label),
            fromShare: row.fromShare,
        })),
        ...(
            await db()
                .select({
                    label: knowledgeRelationTypes.label,
                    fromShare: knowledgeRelationTypes.adoptedFromShare,
                })
                .from(knowledgeRelationTypes)
                .where(eq(knowledgeRelationTypes.userId, orgUserId))
        ).map((row) => ({
            kind: "relation" as const,
            label: decryptText(row.label),
            fromShare: row.fromShare,
        })),
    ];

    it("publishes what it names, adopting the owner's private types it needs, and promoting who and what it names", async () => {
        const toJan = await correct(
            "Novák",
            { personId: jan },
            OWNER,
            "Novotný",
        );
        const toAcme = await correct("Akme", { entityId: acme }, OWNER, "Acme");
        const leads = await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: "leads",
            object: { entityId: orion },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
            speakerLabel: "speaker_0",
        });
        const mentors = await createPrivateType(OWNER, {
            kind: "relation",
            label: "mentors",
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });
        await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: mentors,
            object: { personId: pavel },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
        });

        await share();

        expect(await owners(people, jan)).toBe(orgUserId);
        expect(await owners(knowledgeEntities, orion)).toBe(orgUserId);
        // Her private "Supplier" and "mentors" became the Organization's
        // (Johnny, 2026-09-29), so Acme and the fact went with the share.
        expect(await owners(knowledgeEntities, acme)).toBe(orgUserId);
        expect(await owners(people, pavel)).toBe(orgUserId);
        expect(await scopeOf(toJan)).toBe(orgUserId);
        expect(await scopeOf(toAcme)).toBe(orgUserId);
        const adopted = await orgTypes();
        expect(adopted).toEqual(
            expect.arrayContaining([
                { kind: "entity", label: "Supplier", fromShare: true },
                { kind: "relation", label: "mentors", fromShare: true },
            ]),
        );
        const [ownType] = await db()
            .select({ adoptedAsKey: knowledgeRelationTypes.adoptedAsKey })
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.key, mentors));
        expect(ownType?.adoptedAsKey).toMatch(/^o_/);
        const heardAs = await db()
            .select({ userId: knowledgeAliases.userId })
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.correctionId, toJan));
        expect(heardAs.map((row) => row.userId)).toEqual([orgUserId]);

        const orgFacts = await db()
            .select()
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.userId, orgUserId));
        expect(orgFacts.map((fact) => fact.relationKey).sort()).toEqual(
            ["leads", ownType?.adoptedAsKey].sort(),
        );
        const leadsInOrg = orgFacts.find(
            (fact) => fact.relationKey === "leads",
        );
        const evidence = await db()
            .select({
                userId: knowledgeFactEvidence.userId,
                transcriptionId: knowledgeFactEvidence.transcriptionId,
            })
            .from(knowledgeFactEvidence)
            .where(eq(knowledgeFactEvidence.factId, leadsInOrg?.id ?? ""));
        expect(evidence).toEqual([
            { userId: orgUserId, transcriptionId: transcriptId },
        ]);
        // The owner's own fact and its evidence stay as they were.
        expect(
            await db()
                .select({ id: knowledgeFactEvidence.id })
                .from(knowledgeFactEvidence)
                .where(eq(knowledgeFactEvidence.factId, leads)),
        ).toHaveLength(1);
    });

    it("keeps a fact private that the Organization's relation does not fit, and still shares", async () => {
        const mentors = await createPrivateType(OWNER, {
            kind: "relation",
            label: "mentors",
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });
        // Adopted as an Organization relation between organizations only.
        const partners = await createOrgType(orgUserId, {
            kind: "relation",
            label: "partners with",
            subjectTypes: ["organization"],
            objectTypes: ["organization"],
            objectKind: "entity",
            cardinality: "many",
        });
        await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: mentors,
            object: { personId: pavel },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
        });
        await db()
            .update(knowledgeRelationTypes)
            .set({ adoptedAsKey: partners })
            .where(eq(knowledgeRelationTypes.key, mentors));

        await share();

        expect(
            await db()
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, orgUserId)),
        ).toEqual([]);
        expect(
            await db()
                .select({ id: knowledgeFacts.id })
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, OWNER)),
        ).toHaveLength(1);
        // Nothing of a fact that stays private is published: not whom it
        // names either (Jan is the Organization's as a named speaker).
        expect(await owners(people, pavel)).toBe(OWNER);
    });

    it("adopts no type for what then stays private", async () => {
        const supplies = await createPrivateType(OWNER, {
            kind: "relation",
            label: "supplies",
            subjectTypes: [
                (
                    await db()
                        .select({ typeKey: knowledgeEntities.typeKey })
                        .from(knowledgeEntities)
                        .where(eq(knowledgeEntities.id, acme))
                )[0]?.typeKey ?? "",
            ],
            objectTypes: ["project"],
            objectKind: "entity",
            cardinality: "many",
        });
        // Adopted as an Organization relation between organizations only:
        // "Acme supplies Orion" does not fit it, and stays private.
        const partners = await createOrgType(orgUserId, {
            kind: "relation",
            label: "partners with",
            subjectTypes: ["organization"],
            objectTypes: ["organization"],
            objectKind: "entity",
            cardinality: "many",
        });
        await confirmFactFromRecording({
            subject: { entityId: acme },
            relationKey: supplies,
            object: { entityId: orion },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
        });

        await db()
            .update(knowledgeRelationTypes)
            .set({ adoptedAsKey: partners })
            .where(eq(knowledgeRelationTypes.key, supplies));

        await share();

        expect(
            await db()
                .select({ id: knowledgeFacts.id })
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, orgUserId)),
        ).toEqual([]);
        expect(await owners(knowledgeEntities, acme)).toBe(OWNER);
        // Nothing published names a Supplier: the curator never sees one.
        expect((await orgTypes()).map((type) => type.label)).toEqual([
            "partners with",
        ]);
        // Taken back, not refused: the curator never saw it.
        const [supplier] = await db()
            .select({
                adoptedAsKey: knowledgeEntityTypes.adoptedAsKey,
                refused: knowledgeEntityTypes.adoptionRefusedAt,
            })
            .from(knowledgeEntityTypes)
            .where(eq(knowledgeEntityTypes.userId, OWNER));
        expect(supplier).toEqual({ adoptedAsKey: null, refused: null });
    });

    it("does not overwrite what the Organization knows of a single-valued relation", async () => {
        const [orgJan] = await db()
            .insert(people)
            .values({ userId: orgUserId, displayName: encryptText("Jan N.") })
            .returning({ id: people.id });
        const tavesi = await createEntity(orgUserId, {
            typeKey: "organization",
            name: "Tavesi",
        });
        const orgSaid = await confirmManualFact(orgUserId, {
            subject: { personId: orgJan?.id ?? "" },
            relationKey: "works_for",
            object: { entityId: tavesi.id },
        });
        const ownersOrg = await createEntity(OWNER, {
            typeKey: "organization",
            name: "Orion s.r.o.",
        });
        await db()
            .update(transcriptSpeakers)
            .set({ personId: orgJan?.id ?? "" })
            .where(eq(transcriptSpeakers.transcriptionId, transcriptId));
        await confirmFactFromRecording({
            subject: { personId: orgJan?.id ?? "" },
            relationKey: "works_for",
            object: { entityId: ownersOrg.id },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
            speakerLabel: "speaker_0",
        });

        await share();

        const orgWorksFor = await db()
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(
                and(
                    eq(knowledgeFacts.userId, orgUserId),
                    eq(knowledgeFacts.relationKey, "works_for"),
                ),
            );
        expect(orgWorksFor.map((fact) => fact.id)).toEqual([orgSaid]);
        // The company the private fact names stays the owner's.
        expect(await owners(knowledgeEntities, ownersOrg.id)).toBe(OWNER);
    });

    it("adds its evidence to a single value the Organization already holds, and keeps a different one private", async () => {
        const sla = await createEntity(orgUserId, {
            typeKey: "term",
            name: "SLA",
        });
        const kpi = await createEntity(orgUserId, {
            typeKey: "term",
            name: "KPI",
        });
        const slaMeans = await confirmManualFact(orgUserId, {
            subject: { entityId: sla.id },
            relationKey: "means",
            object: { literal: "Service Level Agreement" },
        });
        const kpiMeans = await confirmManualFact(orgUserId, {
            subject: { entityId: kpi.id },
            relationKey: "means",
            object: { literal: "Key Performance Indicator" },
        });
        for (const [subject, literal] of [
            [sla.id, "Service  Level Agreement "],
            [kpi.id, "Klíčový ukazatel"],
        ] as const) {
            await confirmFactFromRecording({
                subject: { entityId: subject },
                relationKey: "means",
                object: { literal },
                ownerUserId: OWNER,
                transcriptionId: transcriptId,
                revision: 0,
                actorUserId: OWNER,
                orgUserId,
                startMs: 0,
                endMs: 12_000,
            });
        }

        await share();

        const orgFacts = await db()
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.userId, orgUserId));
        expect(orgFacts.map((fact) => fact.id).sort()).toEqual(
            [slaMeans, kpiMeans].sort(),
        );
        const orgEvidence = await db()
            .select({ factId: knowledgeFactEvidence.factId })
            .from(knowledgeFactEvidence)
            .where(eq(knowledgeFactEvidence.userId, orgUserId));
        expect(orgEvidence).toEqual([{ factId: slaMeans }]);
    });

    /** "mentors", adopted as the Organization's "coaches", which the curator deleted. */
    async function refusedMentors() {
        const mentors = await createPrivateType(OWNER, {
            kind: "relation",
            label: "mentors",
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });
        const coaches = await createOrgType(orgUserId, {
            kind: "relation",
            label: "coaches",
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });
        // Said before the adoption, so stored with the private key.
        await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: mentors,
            object: { personId: pavel },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
        });
        await db()
            .update(knowledgeRelationTypes)
            .set({ adoptedAsKey: coaches })
            .where(eq(knowledgeRelationTypes.key, mentors));
        await deleteOwnType(orgUserId, "relation", coaches, 0);
        return mentors;
    }

    const orgFacts = () =>
        db()
            .select({ relationKey: knowledgeFacts.relationKey })
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.userId, orgUserId));

    it("adopts no more a type whose adoption the curator deleted: what uses it stays private", async () => {
        const mentors = await refusedMentors();

        await share();

        expect((await orgTypes()).map((type) => type.label)).not.toContain(
            "mentors",
        );
        expect(await orgFacts()).toEqual([]);
        expect(await owners(people, pavel)).toBe(OWNER);
        const [own] = await db()
            .select({
                adoptedAsKey: knowledgeRelationTypes.adoptedAsKey,
                refused: knowledgeRelationTypes.adoptionRefusedAt,
            })
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.key, mentors));
        expect(own?.adoptedAsKey).toBeNull();
        expect(own?.refused).toBeInstanceOf(Date);
    });

    it("adopts a refused type as the Organization's of its name, once it has one", async () => {
        const mentors = await refusedMentors();
        const orgMentors = await createOrgType(orgUserId, {
            kind: "relation",
            label: "mentors",
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });

        await share();

        expect(await orgFacts()).toEqual([{ relationKey: orgMentors }]);
        const [own] = await db()
            .select({
                adoptedAsKey: knowledgeRelationTypes.adoptedAsKey,
                refused: knowledgeRelationTypes.adoptionRefusedAt,
            })
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.key, mentors));
        expect(own).toEqual({ adoptedAsKey: orgMentors, refused: null });
    });

    it("adopts a refused type as the Organization's again when the curator makes the deleted one anew", async () => {
        const mentors = await refusedMentors();
        const coaches = await createOrgType(orgUserId, {
            kind: "relation",
            label: "coaches",
            subjectTypes: ["person"],
            objectTypes: ["person"],
            objectKind: "entity",
            cardinality: "many",
        });

        await share();

        expect(await orgFacts()).toEqual([{ relationKey: coaches }]);
        const [own] = await db()
            .select({
                adoptedAsKey: knowledgeRelationTypes.adoptedAsKey,
                refused: knowledgeRelationTypes.adoptionRefusedAt,
            })
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.key, mentors));
        expect(own).toEqual({ adoptedAsKey: coaches, refused: null });
    });

    it("keeps a refused relation private while the Organization's of its name has another shape", async () => {
        await refusedMentors();
        await createOrgType(orgUserId, {
            kind: "relation",
            label: "mentors",
            subjectTypes: ["organization"],
            objectTypes: ["organization"],
            objectKind: "entity",
            cardinality: "many",
        });

        await share();

        expect(await orgFacts()).toEqual([]);
        expect(await owners(people, pavel)).toBe(OWNER);
    });

    it("keeps an entity of a refused type private, and what relates it", async () => {
        const [ownSupplier] = await db()
            .select({ key: knowledgeEntityTypes.key })
            .from(knowledgeEntityTypes)
            .where(eq(knowledgeEntityTypes.userId, OWNER));
        const supplies = await createPrivateType(OWNER, {
            kind: "relation",
            label: "supplies",
            subjectTypes: [ownSupplier?.key ?? ""],
            objectTypes: ["project"],
            objectKind: "entity",
            cardinality: "many",
        });
        const orgSupplier = await createOrgType(orgUserId, {
            kind: "entity",
            label: "Supplier",
        });
        await db()
            .update(knowledgeEntityTypes)
            .set({ adoptedAsKey: orgSupplier })
            .where(eq(knowledgeEntityTypes.key, ownSupplier?.key ?? ""));
        await deleteOwnType(orgUserId, "entity", orgSupplier, 0);
        const toAcme = await correct("Akme", { entityId: acme }, OWNER, "Acme");
        await confirmFactFromRecording({
            subject: { entityId: acme },
            relationKey: supplies,
            object: { entityId: orion },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
        });

        await share();

        expect(await owners(knowledgeEntities, acme)).toBe(OWNER);
        expect(await scopeOf(toAcme)).toBe(OWNER);
        expect(await orgFacts()).toEqual([]);
        expect(await orgTypes()).toEqual([]);
    });

    it("uses the Organization's type of the same name and shape, and names a copy of another shape apart", async () => {
        const orgSupplier = await createOrgType(orgUserId, {
            kind: "entity",
            label: "Supplier",
        });
        const [ownSupplier] = await db()
            .select({ key: knowledgeEntityTypes.key })
            .from(knowledgeEntityTypes)
            .where(eq(knowledgeEntityTypes.userId, OWNER));
        const supplies = await createPrivateType(OWNER, {
            kind: "relation",
            label: "supplies",
            subjectTypes: [ownSupplier?.key ?? ""],
            objectTypes: ["project"],
            objectKind: "entity",
            cardinality: "many",
        });
        // The Organization named its own "supplies" since, relating
        // organizations only; hers relates her suppliers to projects.
        await createOrgType(orgUserId, {
            kind: "relation",
            label: "supplies",
            subjectTypes: ["organization"],
            objectTypes: ["organization"],
            objectKind: "entity",
            cardinality: "many",
        });
        await confirmFactFromRecording({
            subject: { entityId: acme },
            relationKey: supplies,
            object: { entityId: orion },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
        });

        await share();

        // Her "Supplier" is the Organization's: no second one.
        const [promoted] = await db()
            .select({ typeKey: knowledgeEntities.typeKey })
            .from(knowledgeEntities)
            .where(eq(knowledgeEntities.id, acme));
        expect(promoted?.typeKey).toBe(orgSupplier);
        const labels = (await orgTypes()).map((type) => type.label).sort();
        expect(labels).toEqual(["Supplier", "supplies", "supplies (2)"]);
        const [copy] = await db()
            .select()
            .from(knowledgeRelationTypes)
            .where(eq(knowledgeRelationTypes.adoptedFromShare, true));
        expect(copy).toMatchObject({
            userId: orgUserId,
            subjectTypes: [orgSupplier],
            objectTypes: ["project"],
        });
        const [fact] = await db()
            .select({ relationKey: knowledgeFacts.relationKey })
            .from(knowledgeFacts)
            .where(eq(knowledgeFacts.userId, orgUserId));
        expect(fact?.relationKey).toBe(copy?.key);
    });

    it("takes the Organization's evidence back on withdrawal, gives the owner the corrections, and publishes again on a new share", async () => {
        const toJan = await correct(
            "Novák",
            { personId: jan },
            OWNER,
            "Novotný",
        );
        await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: "leads",
            object: { entityId: orion },
            ownerUserId: OWNER,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: OWNER,
            orgUserId,
            startMs: 0,
            endMs: 12_000,
            speakerLabel: "speaker_0",
        });
        await share();
        // The curator's own correction, while shared.
        const curators = await correct(
            "Honzovi",
            { personId: jan },
            orgUserId,
            "Janovi",
        );

        await unshareRecording(OWNER, REC, { withdraw: true });

        expect(
            await db()
                .select()
                .from(knowledgeFactEvidence)
                .where(eq(knowledgeFactEvidence.userId, orgUserId)),
        ).toEqual([]);
        expect(
            await db()
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, orgUserId)),
        ).toEqual([]);
        expect(await scopeOf(toJan)).toBe(OWNER);
        expect(await scopeOf(curators)).toBe(OWNER);
        const heardAs = await db()
            .select({ userId: knowledgeAliases.userId })
            .from(knowledgeAliases)
            .where(eq(knowledgeAliases.kind, "heard_as"));
        expect(heardAs.map((row) => row.userId)).toEqual([OWNER, OWNER]);
        // Promoted people and entities stay the Organization's; the owner's
        // fact is untouched.
        const [stillOrg] = await db()
            .select({ userId: people.userId })
            .from(people)
            .where(eq(people.id, jan));
        expect(stillOrg?.userId).toBe(orgUserId);
        expect(
            await db()
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, OWNER)),
        ).toHaveLength(1);

        await share();
        expect(await scopeOf(toJan)).toBe(orgUserId);
        expect(
            await db()
                .select()
                .from(knowledgeFacts)
                .where(eq(knowledgeFacts.userId, orgUserId)),
        ).toHaveLength(1);
    });

    it("shares the correction pass's fixes, with no record to name or one that stays private", async () => {
        const fix = (heard: string, target: { entityId: string } | null) =>
            db()
                .insert(transcriptCorrections)
                .values({
                    userId: OWNER,
                    transcriptionId: transcriptId,
                    transcriptRevision: 0,
                    ...at(heard),
                    heard: encryptText(heard),
                    heardHmac: "h",
                    kind: "fix",
                    targetPersonId: null,
                    targetEntityId: target?.entityId ?? null,
                    replacement: encryptText(`${heard}!`),
                })
                .returning({ id: transcriptCorrections.id })
                .then((rows) => rows[0]?.id ?? "");
        const plain = await fix("zítra", null);
        const named = await fix("Orion", { entityId: orion });
        await share();
        expect(await scopeOf(plain)).toBe(orgUserId);
        expect(await scopeOf(named)).toBe(orgUserId);
        const [shared] = await db()
            .select({ entityId: transcriptCorrections.targetEntityId })
            .from(transcriptCorrections)
            .where(eq(transcriptCorrections.id, named));
        expect(shared?.entityId).not.toBeNull();
    });

    it("exports, for the owner, only the corrections they made on their shared recording, and the Organization all of them", async () => {
        await correct("Novák", { personId: jan }, OWNER, "Novotný");
        await share();
        const apollo = (
            await createEntity(orgUserId, {
                typeKey: "project",
                name: "Apollo",
            })
        ).id;
        await correct("Orion", { entityId: apollo }, orgUserId, "Apollo");

        const archive = async (scope: ArchiveScope) => {
            const storage = new ArchiveStorage();
            await buildAndUploadExportArchive({
                scope,
                sourceStorage: storage,
                destinationStorage: storage,
                storageKey: "exports/archive.zip",
            });
            const directory = await unzipper.Open.buffer(storage.uploaded);
            return async (path: string) => {
                const file = directory.files.find(
                    (entry) => entry.path === path,
                );
                return JSON.parse(
                    (await file?.buffer())?.toString("utf-8") ?? "{}",
                );
            };
        };

        // The owner's: published when shared, still theirs. The
        // Organization's own correction, and what only it names, stay out.
        const owner = await archive({ kind: "personal", userId: OWNER });
        const knowledge = await owner("knowledge/people.json");
        expect(
            knowledge.corrections.map((row: { heard: string }) => row.heard),
        ).toEqual(["Novák"]);
        expect(knowledge.people).toContainEqual(
            expect.objectContaining({ id: jan, organization: true }),
        );
        const entities = await owner("knowledge/entities.json");
        expect(
            (entities.entities ?? []).map((row: { id: string }) => row.id),
        ).not.toContain(apollo);

        // The Organization's: every correction on the shared transcript.
        const organization = await archive({
            kind: "organization",
            orgUserId,
        });
        const shared = await organization("knowledge/people.json");
        expect(
            shared.corrections.map((row: { heard: string }) => row.heard),
        ).toEqual(expect.arrayContaining(["Novák", "Orion"]));
        expect(shared.corrections).toHaveLength(2);
        expect(
            (await organization("knowledge/entities.json")).entities,
        ).toContainEqual(
            expect.objectContaining({ id: apollo, organization: true }),
        );
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
