/**
 * A writer naming a person or an entity while a merge folds them away,
 * against a real PostgreSQL: what it writes ends on the survivor, never on
 * the tombstone.
 *
 * The merge is stalled on purpose after it moved everything and before it
 * leaves the tombstone: a third transaction holds the loser's row. The
 * writer starts only then. Without the Organization-people lock the
 * writer resolves the loser, which is not a tombstone yet, and commits;
 * the merge then tombstones a record the new row still names.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq, sql } from "drizzle-orm";
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
    people,
    recordings,
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
import { addAlias } from "@/lib/knowledge/aliases";
import { acceptCorrection } from "@/lib/knowledge/corrections";
import {
    createEntity,
    deleteEntity,
    mergeEntities,
} from "@/lib/knowledge/entities";
import { confirmFactFromRecording, deleteFact } from "@/lib/knowledge/facts";
import { lockOrgPeople, lockOrgPeopleShared } from "@/lib/knowledge/org-people";
import { deletePerson, mergePeople } from "@/lib/knowledge/people";
import { changeTranscriptSpeaker } from "@/lib/knowledge/speaker-changes";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

type Tx = Parameters<
    Parameters<TestPostgresDatabase["db"]["transaction"]>[0]
>[0];

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const REC = "rec-alice";

const TURNS: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 10_000,
        text: "Tady Novák, vedu projekt Orion pro Tavesi.",
    },
];

describeWithDatabase(
    "writers racing a merge or a deletion (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;
        let orgUserId = "";
        let transcriptId = "";
        let orion = "";

        function db() {
            if (!database) throw new Error("test database was not initialized");
            return database.db;
        }

        beforeAll(async () => {
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "merge_race",
            );
            dbRef.current = database.db as unknown as Record<
                PropertyKey,
                unknown
            >;
        }, 120_000);

        afterAll(async () => {
            dbRef.current = null;
            await database?.dispose();
        }, 30_000);

        beforeEach(async () => {
            await db().delete(users);
            await db()
                .insert(users)
                .values([{ id: ALICE, email: "alice@example.test" }]);
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
        });

        async function person(name: string): Promise<string> {
            const [row] = await db()
                .insert(people)
                .values({ userId: ALICE, displayName: encryptText(name) })
                .returning({ id: people.id });
            return row?.id ?? "";
        }

        /** Backends of this database waiting on a lock. */
        async function lockWaiters(): Promise<number> {
            const rows = await db().execute<{ count: number }>(
                sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
            );
            return Number(rows[0]?.count ?? 0);
        }

        /** True once `count` backends wait on a lock; false after `ms` or when `stop` says so. */
        async function waitForLockWaiters(
            count: number,
            {
                ms = 10_000,
                stop = () => false,
            }: { ms?: number; stop?: () => boolean } = {},
        ): Promise<boolean> {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline && !stop()) {
                if ((await lockWaiters()) >= count) return true;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return false;
        }

        /**
         * Run `merge` stalled at its tombstone (a third transaction holds the
         * loser's row), start `write` then, and let the merge finish. Says
         * whether the writer waited for the merge.
         */
        async function raceMerge({
            holdLoser,
            merge,
            write,
        }: {
            holdLoser: (tx: Tx) => Promise<unknown>;
            merge: () => Promise<unknown>;
            write: () => Promise<unknown>;
        }): Promise<"waited" | "raced"> {
            let release: () => void = () => {};
            const released = new Promise<void>((resolve) => {
                release = resolve;
            });
            let holding: () => void = () => {};
            const held = new Promise<void>((resolve) => {
                holding = resolve;
            });
            const holder = db().transaction(async (tx) => {
                await holdLoser(tx);
                holding();
                await released;
            });
            await held;
            const merging = merge();
            expect(await waitForLockWaiters(1)).toBe(true);

            let written = false;
            const writing = write().finally(() => {
                written = true;
            });
            const waited = await waitForLockWaiters(2, {
                ms: 3_000,
                stop: () => written,
            });
            const outcome = waited && !written ? "waited" : "raced";
            release();
            await holder;
            await merging;
            await writing;
            return outcome;
        }

        function holdPerson(personId: string) {
            return (tx: Tx) =>
                tx
                    .select({ id: people.id })
                    .from(people)
                    .where(eq(people.id, personId))
                    .for("share");
        }

        it("a correction lands on the survivor", async () => {
            const jan = await person("Jan Novotný");
            const honza = await person("Honza");

            const outcome = await raceMerge({
                holdLoser: holdPerson(honza),
                merge: () => mergePeople(ALICE, jan, honza),
                write: () =>
                    acceptCorrection({
                        userId: ALICE,
                        transcriptionId: transcriptId,
                        revision: 0,
                        anchor: {
                            turnIndex: 0,
                            charStart: 5,
                            charEnd: 10,
                            heard: "Novák",
                        },
                        kind: "correct",
                        target: { personId: honza },
                        replacement: "Novotný",
                        actorUserId: ALICE,
                        orgUserId,
                    }),
            });
            expect(outcome).toBe("waited");

            const rows = await db()
                .select({ target: transcriptCorrections.targetPersonId })
                .from(transcriptCorrections);
            expect(rows).toEqual([{ target: jan }]);
            const heardAs = await db()
                .select({ personId: knowledgeAliases.personId })
                .from(knowledgeAliases);
            expect(heardAs).toEqual([{ personId: jan }]);
        });

        it("a fact lands on the survivor", async () => {
            const jan = await person("Jan Novotný");
            const honza = await person("Honza");

            const outcome = await raceMerge({
                holdLoser: holdPerson(honza),
                merge: () => mergePeople(ALICE, jan, honza),
                write: () =>
                    confirmFactFromRecording({
                        subject: { personId: honza },
                        relationKey: "leads",
                        object: { entityId: orion },
                        ownerUserId: ALICE,
                        transcriptionId: transcriptId,
                        revision: 0,
                        actorUserId: ALICE,
                        orgUserId,
                        startMs: 0,
                        endMs: 10_000,
                    }),
            });
            expect(outcome).toBe("waited");

            const facts = await db()
                .select({ subject: knowledgeFacts.subjectPersonId })
                .from(knowledgeFacts);
            expect(facts).toEqual([{ subject: jan }]);
        });

        it("a speaker answer lands on the survivor", async () => {
            const jan = await person("Jan Novotný");
            const honza = await person("Honza");

            const outcome = await raceMerge({
                holdLoser: holdPerson(honza),
                merge: () => mergePeople(ALICE, jan, honza),
                write: () =>
                    changeTranscriptSpeaker({
                        userId: ALICE,
                        transcriptionId: transcriptId,
                        revision: 0,
                        label: "speaker_0",
                        answer: { kind: "name", personId: honza },
                        actorUserId: ALICE,
                        orgUserId,
                    }),
            });
            expect(outcome).toBe("waited");

            const speakers = await db()
                .select({ personId: transcriptSpeakers.personId })
                .from(transcriptSpeakers);
            expect(speakers).toEqual([{ personId: jan }]);
        });

        /**
         * Start `erase` while a transaction holds the recording as a transcript
         * rewrite does, and say whether it waited for it: a deletion takes
         * rows the rewrite updates (corrections, evidence) and must not take
         * them in another order.
         */
        async function waitsForRewrite(erase: () => Promise<unknown>) {
            let release: () => void = () => {};
            const released = new Promise<void>((resolve) => {
                release = resolve;
            });
            let holding: () => void = () => {};
            const held = new Promise<void>((resolve) => {
                holding = resolve;
            });
            const rewrite = db().transaction(async (tx) => {
                await tx
                    .select({ id: recordings.id })
                    .from(recordings)
                    .where(eq(recordings.id, REC))
                    .for("update");
                holding();
                await released;
            });
            await held;
            let done = false;
            const erasing = erase().finally(() => {
                done = true;
            });
            const waited = await waitForLockWaiters(1, {
                ms: 3_000,
                stop: () => done,
            });
            const outcome = waited && !done;
            release();
            await rewrite;
            await erasing;
            return outcome;
        }

        it("deleting a person waits for a rewrite of a recording with evidence about them", async () => {
            const jan = await person("Jan Novotný");
            await confirmFactFromRecording({
                subject: { personId: jan },
                relationKey: "leads",
                object: { entityId: orion },
                ownerUserId: ALICE,
                transcriptionId: transcriptId,
                revision: 0,
                actorUserId: ALICE,
                orgUserId,
                startMs: 0,
                endMs: 10_000,
            });

            expect(await waitsForRewrite(() => deletePerson(ALICE, jan))).toBe(
                true,
            );
            expect(await db().select().from(knowledgeFacts)).toEqual([]);
        });

        it("deleting an entity waits for a rewrite of a recording with evidence about it", async () => {
            const jan = await person("Jan Novotný");
            await confirmFactFromRecording({
                subject: { personId: jan },
                relationKey: "leads",
                object: { entityId: orion },
                ownerUserId: ALICE,
                transcriptionId: transcriptId,
                revision: 0,
                actorUserId: ALICE,
                orgUserId,
                startMs: 0,
                endMs: 10_000,
            });

            expect(
                await waitsForRewrite(() => deleteEntity(ALICE, orion)),
            ).toBe(true);
            expect(await db().select().from(knowledgeFacts)).toEqual([]);
        });

        /** Whether `act` waits while another transaction holds the Organization-people lock. */
        async function waitsForOrgPeople(
            shared: boolean,
            act: () => Promise<unknown>,
        ) {
            let release: () => void = () => {};
            const released = new Promise<void>((resolve) => {
                release = resolve;
            });
            let holding: () => void = () => {};
            const held = new Promise<void>((resolve) => {
                holding = resolve;
            });
            const holder = db().transaction(async (tx) => {
                await (shared
                    ? lockOrgPeopleShared(tx as never)
                    : lockOrgPeople(tx as never));
                holding();
                await released;
            });
            await held;
            let done = false;
            const acting = act().finally(() => {
                done = true;
            });
            const waited = await waitForLockWaiters(1, {
                ms: 3_000,
                stop: () => done,
            });
            const outcome = waited && !done;
            release();
            await holder;
            await acting;
            return outcome;
        }

        it("deleting a fact waits for a deletion, a merge or a confirmation in progress", async () => {
            const jan = await person("Jan Novotný");
            const fact = () =>
                confirmFactFromRecording({
                    subject: { personId: jan },
                    relationKey: "leads",
                    object: { entityId: orion },
                    ownerUserId: ALICE,
                    transcriptionId: transcriptId,
                    revision: 0,
                    actorUserId: ALICE,
                    orgUserId,
                    startMs: 0,
                    endMs: 10_000,
                });
            // A person deletion or a merge holds the lock from its start, a
            // confirmation holds it shared: a fact deletion racing either
            // over a chain of replacements deadlocked (review of the fixes).
            const first = await fact();
            expect(
                await waitsForOrgPeople(false, () => deleteFact(ALICE, first)),
            ).toBe(true);
            const second = await fact();
            expect(
                await waitsForOrgPeople(true, () => deleteFact(ALICE, second)),
            ).toBe(true);
        });

        it("an alias lands on the surviving entity", async () => {
            const tavesi = (
                await createEntity(ALICE, {
                    typeKey: "organization",
                    name: "Tavesi",
                })
            ).id;
            const acme = (
                await createEntity(ALICE, {
                    typeKey: "organization",
                    name: "Acme",
                })
            ).id;

            const outcome = await raceMerge({
                holdLoser: (tx) =>
                    tx
                        .select({ id: knowledgeEntities.id })
                        .from(knowledgeEntities)
                        .where(eq(knowledgeEntities.id, acme))
                        .for("share"),
                merge: () => mergeEntities(ALICE, tavesi, acme),
                write: () => addAlias(ALICE, { entityId: acme }, "Akme"),
            });
            expect(outcome).toBe("waited");

            const aliases = await db()
                .select({ entityId: knowledgeAliases.entityId })
                .from(knowledgeAliases);
            expect(aliases).toEqual([{ entityId: tavesi }]);
        });
    },
);
