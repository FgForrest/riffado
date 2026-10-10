/**
 * Scope generations against a real PostgreSQL: every path that changes or
 * erases knowledge moves the generation of every scope it reaches, cascades
 * included, and no other. A process holding a scope in memory reloads it
 * when its generation moved, so a scope missed here would keep showing an
 * erased name.
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
    knowledgeScopeGenerations,
    people,
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
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        exists: vi.fn().mockResolvedValue(false),
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

import { DELETE as deleteRecordingRoute } from "@/app/api/recordings/[id]/route";
import { deleteTranscriptsForRecording } from "@/db/queries/retention";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addAlias } from "@/lib/knowledge/aliases";
import {
    createEntity,
    deleteEntity,
    describeEntity,
    mergeEntities,
} from "@/lib/knowledge/entities";
import {
    confirmFactFromRecording,
    confirmManualFact,
} from "@/lib/knowledge/facts";
import {
    addPersonNotes,
    deletePerson,
    mergePeople,
    updatePerson,
} from "@/lib/knowledge/people";
import { changeTranscriptSpeaker } from "@/lib/knowledge/speaker-changes";
import {
    createOrgType,
    deleteOwnType,
    seedCoreVocabulary,
} from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import { eraseLocalArtifact } from "@/lib/recordings/erase";
import { upsertTranscription } from "@/lib/transcription/persist";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";
const DAVE = "user-dave";
const REC = "rec-alice";

const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 10_000,
        text: "Tady Novák, projekt Oryon jede.",
    },
];

describeWithDatabase("scope generations (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let orgJan = "";
    let transcriptId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "scope_generations",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    async function generations(): Promise<Map<string, number>> {
        const rows = await db().select().from(knowledgeScopeGenerations);
        return new Map(rows.map((row) => [row.userId, row.generation]));
    }

    /** The scopes whose generation `change` moved. */
    async function moved(change: () => Promise<unknown>): Promise<string[]> {
        const before = await generations();
        await change();
        const after = await generations();
        return [...after.keys()]
            .filter((scope) => after.get(scope) !== before.get(scope))
            .sort();
    }

    const sorted = (...scopes: string[]) => [...scopes].sort();

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
                { id: DAVE, email: "dave@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await seedCoreVocabulary();
        const [jan] = await db()
            .insert(people)
            .values({ userId: orgUserId, displayName: encryptText("Jan") })
            .returning({ id: people.id });
        orgJan = jan?.id ?? "";
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
            storageFilename: "rec.mp3",
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
        // Dave knows something too, and nothing below is about him.
        await addAlias(DAVE, { personId: orgJan }, "Jenda");
        await db().delete(knowledgeScopeGenerations);
        await addAlias(DAVE, { personId: orgJan }, "Honzík");
    });

    /** Alice's knowledge on her recording: her fact about Jan, with evidence. */
    async function aliceSaysJanLeadsOrion() {
        const orion = await createEntity(ALICE, {
            typeKey: "project",
            name: "Orion",
        });
        await db().insert(transcriptSpeakers).values({
            userId: ALICE,
            transcriptionId: transcriptId,
            label: "speaker_0",
            personId: orgJan,
            source: "user",
            status: "confirmed",
            confirmedByUserId: ALICE,
        });
        await confirmFactFromRecording({
            subject: { personId: orgJan },
            relationKey: "leads",
            object: { entityId: orion.id },
            ownerUserId: ALICE,
            transcriptionId: transcriptId,
            revision: 0,
            actorUserId: ALICE,
            orgUserId,
            startMs: 0,
            endMs: 10_000,
            speakerLabel: "speaker_0",
        });
        return orion.id;
    }

    /** An Organization correction left on Alice's transcript. */
    async function orgCorrection(targetPersonId = orgJan) {
        await db()
            .insert(transcriptCorrections)
            .values({
                userId: orgUserId,
                transcriptionId: transcriptId,
                transcriptRevision: 0,
                turnIndex: 0,
                charStart: 5,
                charEnd: 10,
                heard: encryptText("Novák"),
                heardHmac: "h",
                kind: "link",
                targetPersonId,
            });
    }

    it("moves the scopes a person's rename or erasure reaches, cascades included", async () => {
        await addAlias(ALICE, { personId: orgJan }, "Honza");
        await addPersonNotes(orgJan, BOB, "Plays chess");
        expect(
            await moved(() =>
                updatePerson(orgUserId, orgJan, { displayName: "Jan N." }),
            ),
        ).toEqual(sorted(orgUserId, ALICE, BOB, DAVE));

        await aliceSaysJanLeadsOrion();
        await orgCorrection();
        await db().delete(knowledgeScopeGenerations);
        expect(await moved(() => deletePerson(orgUserId, orgJan))).toEqual(
            sorted(orgUserId, ALICE, BOB, DAVE),
        );
    });

    it("moves only the scopes a person's merge reaches", async () => {
        const [alicesJan] = await db()
            .insert(people)
            .values({ userId: ALICE, displayName: encryptText("Jan") })
            .returning({ id: people.id });
        await addAlias(ALICE, { personId: alicesJan?.id ?? "" }, "Honza");
        expect(
            await moved(() => mergePeople(ALICE, orgJan, alicesJan?.id ?? "")),
        ).toEqual(sorted(orgUserId, ALICE, DAVE));
    });

    it("moves the scopes an entity's merge or erasure reaches", async () => {
        const shared = await createEntity(orgUserId, {
            typeKey: "project",
            name: "Orion",
        });
        const mine = await createEntity(ALICE, {
            typeKey: "project",
            name: "Orion (mine)",
        });
        await describeEntity(BOB, shared.id, "Late again");
        expect(
            await moved(() => mergeEntities(ALICE, shared.id, mine.id)),
        ).toEqual(sorted(orgUserId, ALICE, BOB));
        await addAlias(ALICE, { entityId: shared.id }, "Oryon");
        expect(await moved(() => deleteEntity(orgUserId, shared.id))).toEqual(
            sorted(orgUserId, ALICE, BOB),
        );
    });

    it("moves the scopes an Organization type's deletion reaches", async () => {
        const vendor = await createOrgType(orgUserId, {
            kind: "entity",
            label: "Vendor",
        });
        const acme = await createEntity(orgUserId, {
            typeKey: vendor,
            name: "Acme",
        });
        await addAlias(BOB, { entityId: acme.id }, "Akme");
        expect(
            await moved(() => deleteOwnType(orgUserId, "entity", vendor, 1)),
        ).toEqual(sorted(orgUserId, BOB));
    });

    it("moves the scopes whose knowledge a transcript's rewrite touched", async () => {
        await aliceSaysJanLeadsOrion();
        await orgCorrection();
        expect(
            await moved(() =>
                upsertTranscription({
                    userId: ALICE,
                    recordingId: REC,
                    text: "Něco jiného.",
                    detectedLanguage: "cs",
                    source: "riffado",
                    provider: "openai",
                    model: "gpt-4o-transcribe-diarize",
                    turns: [
                        {
                            ...(TURNS[0] as TranscriptTurn),
                            text: "Něco jiného.",
                        },
                    ],
                }),
            ),
        ).toEqual(sorted(orgUserId, ALICE));
    });

    it("moves the scope of evidence a renamed speaker puts to review", async () => {
        await aliceSaysJanLeadsOrion();
        const [pavel] = await db()
            .insert(people)
            .values({ userId: ALICE, displayName: encryptText("Pavel") })
            .returning({ id: people.id });
        expect(
            await moved(() =>
                changeTranscriptSpeaker({
                    userId: ALICE,
                    transcriptionId: transcriptId,
                    revision: 0,
                    label: "speaker_0",
                    answer: { kind: "name", personId: pavel?.id ?? "" },
                    actorUserId: ALICE,
                    orgUserId,
                }),
            ),
        ).toEqual([ALICE]);
    });

    it.each([
        [
            "retention",
            () =>
                deleteTranscriptsForRecording(
                    REC,
                    ALICE,
                    { isOrg: false, orgUserId: "" },
                    new Date(),
                ),
        ],
        ["erase", () => eraseLocalArtifact(ALICE, REC, "transcript")],
        [
            "the recording DELETE",
            async () =>
                deleteRecordingRoute(
                    new Request(`http://localhost/api/recordings/${REC}`, {
                        method: "DELETE",
                        headers: { "x-test-user": ALICE },
                    }),
                    { params: Promise.resolve({ id: REC }) },
                ),
        ],
    ])("moves the scopes whose knowledge %s takes with the transcript", async (_path, remove) => {
        await aliceSaysJanLeadsOrion();
        await orgCorrection();
        expect(await moved(remove)).toEqual(sorted(orgUserId, ALICE));
    });

    it("moves the writer's scope for everything written directly", async () => {
        const orion = await createEntity(ALICE, {
            typeKey: "project",
            name: "Orion",
        });
        expect(
            await moved(() =>
                confirmManualFact(ALICE, {
                    subject: { personId: orgJan },
                    relationKey: "works_on",
                    object: { entityId: orion.id },
                }),
            ),
        ).toEqual([ALICE]);
        expect(
            await moved(() =>
                addAlias(BOB, { entityId: orion.id }, "x").catch(() => null),
            ),
        ).toEqual([]);
        const [dave] = await db()
            .select()
            .from(knowledgeScopeGenerations)
            .where(eq(knowledgeScopeGenerations.userId, DAVE));
        expect(dave?.generation).toBe(1);
    });
});
