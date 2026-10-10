/**
 * Speaker names an older release copied from Plaud's transcript onto the
 * user's own were stored as confirmed. Decision D1 (a) turns them back
 * into suggestions once, in migration 0062, recognized by the missing
 * confirmer and the same person named on the Plaud transcript.
 *
 * This runs that migration's SQL against rows as the older release left
 * them.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { people, transcriptions, transcriptSpeakers, users } from "@/db/schema";
import { insertRecordings } from "@/tests/integration/items";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const MIGRATION = join(
    process.cwd(),
    "src/db/migrations/0062_demote_copied_speaker_names.sql",
);

const ALICE = "user-alice";
const REC = "rec-meeting";

describeWithDatabase("demoting copied speaker names (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let jana = "";
    let petr = "";
    let plaud = "";
    let own = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    /** Apply the migration, as the release's startup does once. */
    async function demote() {
        await db().execute(sql.raw(readFileSync(MIGRATION, "utf-8")));
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "attribution_demotion",
        );
    }, 120_000);

    afterAll(async () => {
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        await db().delete(users);
        await db().insert(users).values({ id: ALICE, email: "a@x.test" });
        await insertRecordings(db(), {
            id: REC,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: "Weekly",
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/rec.mp3`,
            plaudVersion: "1",
        });
        const inserted = await db()
            .insert(people)
            .values([
                { userId: ALICE, displayName: "Jana" },
                { userId: ALICE, displayName: "Petr" },
            ])
            .returning({ id: people.id });
        jana = inserted[0]?.id ?? "";
        petr = inserted[1]?.id ?? "";
        const transcripts = await db()
            .insert(transcriptions)
            .values(
                (["plaud", "riffado"] as const).map((source) => ({
                    recordingId: REC,
                    userId: ALICE,
                    text: "speaker_0: Hi\nspeaker_1: Hello",
                    provider: source,
                    model: "plaud",
                    source,
                })),
            )
            .returning({ id: transcriptions.id });
        plaud = transcripts[0]?.id ?? "";
        own = transcripts[1]?.id ?? "";
    });

    async function row(
        transcriptionId: string,
        label: string,
        personId: string,
        confirmedByUserId: string | null = null,
    ) {
        await db().insert(transcriptSpeakers).values({
            userId: ALICE,
            transcriptionId,
            label,
            personId,
            source: "user",
            status: "confirmed",
            confirmedByUserId,
        });
    }

    async function statusOf(transcriptionId: string) {
        const rows = await db()
            .select({
                label: transcriptSpeakers.label,
                status: transcriptSpeakers.status,
                source: transcriptSpeakers.source,
            })
            .from(transcriptSpeakers)
            .where(eq(transcriptSpeakers.transcriptionId, transcriptionId));
        return rows.sort((a, b) => a.label.localeCompare(b.label));
    }

    it("demotes a name the copy stored as confirmed", async () => {
        await row(plaud, "Speaker 1", jana);
        await row(own, "speaker_0", jana);

        await demote();
        expect(await statusOf(own)).toEqual([
            { label: "speaker_0", status: "suggested", source: "heuristic" },
        ]);
        // The Plaud transcript's own names are the source, not a copy.
        expect(await statusOf(plaud)).toEqual([
            { label: "Speaker 1", status: "confirmed", source: "user" },
        ]);
    });

    it("keeps a name only the Riffado transcript has", async () => {
        await row(plaud, "Speaker 1", jana);
        await row(own, "speaker_1", petr);

        await demote();
        expect(await statusOf(own)).toEqual([
            { label: "speaker_1", status: "confirmed", source: "user" },
        ]);
    });

    it("keeps a name a person confirmed since the confirmer existed", async () => {
        await row(plaud, "Speaker 1", jana);
        await row(own, "speaker_0", jana, ALICE);

        await demote();
        expect(await statusOf(own)).toEqual([
            { label: "speaker_0", status: "confirmed", source: "user" },
        ]);
    });
});
