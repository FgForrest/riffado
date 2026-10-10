/**
 * What the People and entity pages show of facts, against a real
 * PostgreSQL: the viewer's own and the Organization's, grouped by relation
 * with the other side named, and evidence only from recordings the viewer
 * can open.
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

import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder } from "@/lib/folders/folders";
import { createEntity } from "@/lib/knowledge/entities";
import { factsForPage } from "@/lib/knowledge/fact-page";
import {
    confirmFactFromRecording,
    confirmManualFact,
} from "@/lib/knowledge/facts";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 30_000,
        text: "Vedu projekt Orion, a jsem tu technický ředitel.",
    },
];

describeWithDatabase("facts on the pages (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let jan = "";
    let orion = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "fact_page",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    async function recordingWithJan(id: string): Promise<string> {
        await insertRecordings(db(), {
            id,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText(`Meeting ${id}`),
            duration: 30_000,
            startTime: new Date("2026-03-03T12:04:00Z"),
            endTime: new Date("2026-03-03T12:04:30Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/${id}.mp3`,
            plaudVersion: "1",
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: id,
                userId: ALICE,
                text: encryptText(TURNS[0]?.text ?? ""),
                turns: encryptJsonField(TURNS),
                provider: "openai",
                model: "gpt-4o-transcribe-diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        await db()
            .insert(transcriptSpeakers)
            .values({
                userId: ALICE,
                transcriptionId: transcript?.id ?? "",
                label: "speaker_0",
                personId: jan,
                source: "user",
                status: "confirmed",
                confirmedByUserId: ALICE,
            });
        return transcript?.id ?? "";
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
        const [row] = await db()
            .insert(people)
            .values({ userId: ALICE, displayName: encryptText("Jan Novotný") })
            .returning({ id: people.id });
        jan = row?.id ?? "";
        orion = (
            await createEntity(ALICE, { typeKey: "project", name: "Orion" })
        ).id;
    });

    it("shows the owner their facts by relation, with where they were said", async () => {
        const transcriptionId = await recordingWithJan("rec-1");
        await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: "leads",
            object: { entityId: orion },
            ownerUserId: ALICE,
            transcriptionId,
            revision: 0,
            actorUserId: ALICE,
            orgUserId,
            startMs: 0,
            endMs: 30_000,
            speakerLabel: "speaker_0",
        });
        await confirmManualFact(ALICE, {
            subject: { personId: jan },
            relationKey: "has_role",
            object: { literal: "technický ředitel" },
        });

        const onJan = await factsForPage(ALICE, orgUserId, { personId: jan });
        expect(onJan.map((relation) => relation.label)).toEqual([
            "has the role",
            "leads",
        ]);
        expect(onJan[1]?.facts[0]).toMatchObject({
            direction: "subject",
            other: { kind: "entity", id: orion, text: "Orion" },
            scope: "personal",
            evidence: [
                expect.objectContaining({
                    recordingId: "rec-1",
                    title: "Meeting rec-1",
                    startMs: 0,
                    view: "private",
                }),
            ],
        });
        expect(onJan[0]?.facts[0]?.other).toEqual({
            kind: "literal",
            text: "technický ředitel",
        });

        const onOrion = await factsForPage(ALICE, orgUserId, {
            entityId: orion,
        });
        expect(onOrion[0]?.facts[0]).toMatchObject({
            direction: "object",
            other: { kind: "person", id: jan, text: "Jan Novotný" },
        });
    });

    it("shows no one else the owner's facts, and everyone the shared ones with their evidence", async () => {
        const transcriptionId = await recordingWithJan("rec-1");
        await confirmFactFromRecording({
            subject: { personId: jan },
            relationKey: "leads",
            object: { entityId: orion },
            ownerUserId: ALICE,
            transcriptionId,
            revision: 0,
            actorUserId: ALICE,
            orgUserId,
            startMs: 0,
            endMs: 30_000,
            speakerLabel: "speaker_0",
        });
        expect(await factsForPage(BOB, orgUserId, { personId: jan })).toEqual(
            [],
        );

        // Shared: Jan and Orion become the Organization's, and so does the fact.
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: ALICE,
            recordingId: "rec-1",
            folderId: root?.id ?? "",
        });

        const bobSees = await factsForPage(BOB, orgUserId, { personId: jan });
        expect(bobSees).toEqual([
            expect.objectContaining({
                label: "leads",
                facts: [
                    expect.objectContaining({
                        scope: "org",
                        evidence: [
                            expect.objectContaining({
                                recordingId: "rec-1",
                                view: "org",
                            }),
                        ],
                    }),
                ],
            }),
        ]);
    });
});
