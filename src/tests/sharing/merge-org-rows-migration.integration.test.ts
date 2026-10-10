/**
 * Migration 0066: the rows the organization account held of a shared
 * recording, before a shared recording was one recording, become the
 * recording's own. Runs the file against rows as that release left them.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    aiEnhancements,
    people,
    recordingFolderAssignments,
    recordingFolders,
    transcriptions,
    transcriptSpeakerRejections,
    transcriptSpeakers,
    users,
} from "@/db/schema";
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
    "src/db/migrations/0066_merge_org_rows.sql",
);

const OWNER = "user-owner";
const ORG = "user-org";

describeWithDatabase("merging the Organization's rows (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "merge_org_rows",
        );
    }, 120_000);

    afterAll(async () => {
        await database?.dispose();
    }, 30_000);

    async function recording(id: string) {
        await insertRecordings(db(), {
            id,
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: id,
            filename: "Weekly",
            duration: 60_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:01:00Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/${id}.mp3`,
            plaudVersion: "1",
        });
    }

    async function transcript(
        recordingId: string,
        userId: string,
        source: string,
        text: string,
    ) {
        const [row] = await db()
            .insert(transcriptions)
            .values({
                recordingId,
                userId,
                text,
                provider: "openai",
                model: "whisper-1",
                source,
            })
            .returning({ id: transcriptions.id });
        return row?.id ?? "";
    }

    async function summary(
        recordingId: string,
        userId: string,
        transcriptionId: string,
        text: string,
    ) {
        const [row] = await db()
            .insert(aiEnhancements)
            .values({
                itemId: recordingId,
                userId,
                transcriptionId,
                summary: text,
                provider: "openai",
                model: "gpt",
                source: "riffado",
            })
            .returning({ id: aiEnhancements.id });
        return row?.id ?? "";
    }

    it("makes the Organization's rows of a shared recording its own, and drops the rest", async () => {
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test" },
                { id: ORG, email: "org@example.test", role: "org" },
            ]);
        const [folder] = await db()
            .insert(recordingFolders)
            .values({ userId: ORG, name: "Organization", nameHash: "root" })
            .returning({ id: recordingFolders.id });
        await recording("rec-shared");
        await recording("rec-withdrawn");
        // The owner's retention had reaped their rows; the Organization's
        // stayed, and become the recording's here. The markers were on
        // `recordings` when this migration ran.
        await db().execute(sql`
            UPDATE recordings
            SET transcript_reaped_at = '2026-09-10T00:00:00Z',
                summary_reaped_at = '2026-09-10T00:00:00Z'
            WHERE id = 'rec-shared'
        `);
        await db()
            .insert(recordingFolderAssignments)
            .values({
                userId: OWNER,
                itemId: "rec-shared",
                folderId: folder?.id ?? "",
            });
        const [jana] = await db()
            .insert(people)
            .values({ userId: ORG, displayName: "Jana" })
            .returning({ id: people.id });

        // Shared: the owner's two transcripts and summary, and the
        // Organization's re-run of the Riffado one, named, with a summary
        // made from the owner's transcript before it had its own.
        const ownRiffado = await transcript(
            "rec-shared",
            OWNER,
            "riffado",
            "owner's",
        );
        const ownPlaud = await transcript(
            "rec-shared",
            OWNER,
            "plaud",
            "Plaud's",
        );
        await summary("rec-shared", OWNER, ownRiffado, "owner's summary");
        const orgRiffado = await transcript(
            "rec-shared",
            ORG,
            "riffado",
            "Organization's",
        );
        await db().insert(transcriptSpeakers).values({
            userId: ORG,
            transcriptionId: orgRiffado,
            label: "speaker_0",
            personId: jana?.id,
            source: "user",
            status: "confirmed",
            confirmedByUserId: ORG,
        });
        await db()
            .insert(transcriptSpeakerRejections)
            .values({
                userId: ORG,
                transcriptionId: orgRiffado,
                label: "speaker_1",
                personId: jana?.id ?? "",
            });
        const orgSummary = await summary(
            "rec-shared",
            ORG,
            ownRiffado,
            "Organization's summary",
        );
        // Withdrawn by a path around the unshare: the Organization's rows
        // were left behind.
        await transcript("rec-withdrawn", OWNER, "riffado", "kept");
        const leftover = await transcript(
            "rec-withdrawn",
            ORG,
            "riffado",
            "left behind",
        );
        await summary("rec-withdrawn", ORG, leftover, "left behind");

        for (const statement of readFileSync(MIGRATION, "utf-8")
            .split("--> statement-breakpoint")
            .map((part) => part.trim())
            .filter(Boolean)) {
            await db().execute(sql.raw(statement));
        }

        const rows = await db()
            .select({
                id: transcriptions.id,
                recordingId: transcriptions.recordingId,
                userId: transcriptions.userId,
                source: transcriptions.source,
                text: transcriptions.text,
            })
            .from(transcriptions)
            .orderBy(transcriptions.recordingId, transcriptions.source);
        expect(rows).toEqual([
            {
                id: ownPlaud,
                recordingId: "rec-shared",
                userId: OWNER,
                source: "plaud",
                text: "Plaud's",
            },
            {
                id: orgRiffado,
                recordingId: "rec-shared",
                userId: OWNER,
                source: "riffado",
                text: "Organization's",
            },
            {
                id: expect.any(String),
                recordingId: "rec-withdrawn",
                userId: OWNER,
                source: "riffado",
                text: "kept",
            },
        ]);
        expect(
            await db()
                .select({
                    userId: transcriptSpeakers.userId,
                    personId: transcriptSpeakers.personId,
                })
                .from(transcriptSpeakers),
        ).toEqual([{ userId: OWNER, personId: jana?.id }]);
        expect(
            await db()
                .select({ userId: transcriptSpeakerRejections.userId })
                .from(transcriptSpeakerRejections),
        ).toEqual([{ userId: OWNER }]);
        expect(
            await db()
                .select({
                    id: aiEnhancements.id,
                    userId: aiEnhancements.userId,
                    transcriptionId: aiEnhancements.transcriptionId,
                })
                .from(aiEnhancements),
        ).toEqual([
            { id: orgSummary, userId: OWNER, transcriptionId: orgRiffado },
        ]);
        expect(
            await db()
                .select()
                .from(transcriptions)
                .where(eq(transcriptions.userId, ORG)),
        ).toEqual([]);
        // Present again, so no longer marked reaped: retention sees them.
        const [shared] = await db().execute<{
            transcript: string | null;
            summary: string | null;
        }>(sql`
            SELECT transcript_reaped_at AS transcript,
                summary_reaped_at AS summary
            FROM recordings
            WHERE id = 'rec-shared'
        `);
        expect(shared).toEqual({ transcript: null, summary: null });
    });
});
