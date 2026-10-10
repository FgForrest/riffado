/**
 * Decision D2 (a): every title that exists when `title_edited_at` arrives
 * counts as set by a person, so re-transcribing an old recording never
 * replaces it with a generated one. New recordings start unprotected, and
 * so does an old one that was never transcribed: its first transcription
 * names it, as it always did.
 *
 * Migration 0060 adds the column with a `now()` default, which stamps the
 * existing rows; 0061 drops the default; 0063 takes the stamp back where
 * no transcript ever existed. This runs those files against rows that
 * existed before them.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transcriptions, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const MIGRATIONS = join(process.cwd(), "src/db/migrations");

function statements(file: string): string[] {
    return readFileSync(join(MIGRATIONS, file), "utf-8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);
}

describeWithDatabase("protecting existing titles (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "title_protection",
        );
    }, 120_000);

    afterAll(async () => {
        await database?.dispose();
    }, 30_000);

    async function insertRecording(id: string, transcriptReaped = false) {
        await db().execute(sql`
            INSERT INTO chatter_items (id, user_id, kind, title, occurred_at)
            VALUES (${id}, 'user-1', 'audio', 'Weekly', now())
        `);
        await db().execute(sql`
            INSERT INTO recordings (
                id, user_id, device_sn, plaud_file_id, filename, duration,
                start_time, end_time, filesize, file_md5, storage_type,
                storage_path, plaud_version, transcript_reaped_at
            ) VALUES (
                ${id}, 'user-1', 'SN-1', ${id}, 'Weekly', 60000,
                now(), now(), 11, ${"0".repeat(32)}, 'local',
                ${`user-1/${id}.mp3`}, '1',
                ${transcriptReaped ? sql`now()` : null}
            )
        `);
    }

    it("stamps the titles that existed, and leaves new ones unprotected", async () => {
        await db().insert(users).values({ id: "user-1", email: "a@x.test" });
        // As before the migrations ran.
        await db().execute(
            sql`ALTER TABLE recordings DROP COLUMN title_edited_at`,
        );
        await insertRecording("rec-old");
        await insertRecording("rec-untranscribed");
        // Transcribed once; retention removed the transcript since.
        await insertRecording("rec-reaped", true);
        await db().insert(transcriptions).values({
            recordingId: "rec-old",
            userId: "user-1",
            text: "speaker_0: Hello",
            source: "riffado",
            provider: "openai",
            model: "whisper-1",
        });

        for (const file of [
            "0060_protect_existing_titles.sql",
            "0061_title_edited_at_no_default.sql",
            "0063_title_for_untranscribed.sql",
        ]) {
            for (const statement of statements(file)) {
                await db().execute(sql.raw(statement));
            }
        }
        await insertRecording("rec-new");

        // The column these migrations wrote, read as they left it.
        const titleEditedAt = async (id: string) => {
            const rows = await db().execute<{ at: string | null }>(
                sql`SELECT title_edited_at AS at FROM recordings WHERE id = ${id}`,
            );
            const at = rows[0]?.at;
            return at === undefined || at === null ? at : new Date(at);
        };
        expect(await titleEditedAt("rec-old")).toBeInstanceOf(Date);
        expect(await titleEditedAt("rec-reaped")).toBeInstanceOf(Date);
        expect(await titleEditedAt("rec-untranscribed")).toBeNull();
        expect(await titleEditedAt("rec-new")).toBeNull();
    });
});
