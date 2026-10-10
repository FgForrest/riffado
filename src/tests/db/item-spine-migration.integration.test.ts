/**
 * The item spine (migrations 0095-0097) against a database that already
 * holds recordings: every recording becomes an item with the same id and
 * the moved values, every row pointing at a recording still points at it,
 * and the new keys hold from then on.
 *
 * An empty database passes any ordering of these steps, so this migrates
 * to 0094 first, seeds every table that references `recordings`, and only
 * then applies the rest.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    migrateTestDatabase,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const MIGRATIONS = join(process.cwd(), "src/db/migrations");
const LAST_BEFORE_SPINE = 94;

/** A copy of the migrations folder that ends at `lastIdx`. */
function migrationsUpTo(lastIdx: number): string {
    const dir = mkdtempSync(join(tmpdir(), "riffado-spine-"));
    cpSync(MIGRATIONS, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
}

/** Tables with a column pointing at a recording, and that column. */
const REFERENCING = [
    "recording_folder_assignments",
    "folder_export_placements",
    "folder_export_materializations",
    "transcriptions",
    "knowledge_fact_evidence",
    "learn_runs",
    "transcript_correction_passes",
    "learn_dismissals",
    "ai_enhancements",
    "recording_tasks",
    "recording_task_rejections",
    "task_update_proposals",
    "ai_usage_events",
    "webhook_deliveries",
] as const;

describeWithDatabase(
    "the item spine on a populated database (PostgreSQL)",
    () => {
        let database: TestPostgresDatabase | null = null;
        let partialFolder = "";
        const counts = new Map<string, number>();

        function db() {
            if (!database) throw new Error("test database was not initialized");
            return database.db;
        }

        async function count(table: string): Promise<number> {
            const rows = await db().execute<{ n: number }>(
                sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`,
            );
            return rows[0]?.n ?? 0;
        }

        beforeAll(async () => {
            partialFolder = migrationsUpTo(LAST_BEFORE_SPINE);
            database = await createMigratedTestDatabase(
                testDatabaseUrl ?? "",
                "item_spine",
                partialFolder,
            );
            const run = (statement: ReturnType<typeof sql>) =>
                db().execute(statement);

            await run(sql`
            INSERT INTO users (id, email) VALUES
                ('u1', 'u1@example.test'),
                ('u2', 'u2@example.test')
        `);
            await run(sql`
            INSERT INTO recordings (
                id, user_id, device_sn, plaud_file_id, filename, duration,
                start_time, end_time, filesize, file_md5, storage_type,
                storage_path, plaud_version, title_edited_at, summary_due_at,
                transcript_reaped_at, summary_reaped_at, deleted_at,
                created_at, updated_at
            ) VALUES
                ('r1', 'u1', 'SN', 'p1', 'enc:one', 1000,
                 '2026-09-01 10:00:00', '2026-09-01 10:00:01', 1, ${"0".repeat(32)},
                 'local', 'u1/r1.mp3', '1', '2026-09-02 08:00:00',
                 '2026-09-03 09:00:00', '2026-09-04 10:00:00',
                 '2026-09-05 11:00:00', NULL,
                 '2026-09-01 10:05:00', '2026-09-06 12:00:00'),
                ('r2', 'u1', 'SN', 'p2', 'enc:two', 1000,
                 '2026-09-02 10:00:00', '2026-09-02 10:00:01', 1, ${"0".repeat(32)},
                 'local', 'u1/r2.mp3', '1', NULL, NULL, NULL, NULL,
                 '2026-09-07 00:00:00',
                 '2026-09-02 10:05:00', '2026-09-07 00:00:00'),
                ('r3', 'u2', 'local', 'p3', 'enc:three', 1000,
                 '2026-09-03 10:00:00', '2026-09-03 10:00:01', 1, ${"0".repeat(32)},
                 'local', 'u2/r3.mp3', '1', NULL, NULL, NULL, NULL, NULL,
                 '2026-09-03 10:05:00', '2026-09-03 10:05:00')
        `);
            await run(sql`
            INSERT INTO recording_folders (id, user_id, name, name_hash)
            VALUES ('f1', 'u1', 'enc:Weekly', 'h1')
        `);
            await run(sql`
            INSERT INTO recording_folder_assignments (user_id, recording_id, folder_id)
            VALUES ('u1', 'r1', 'f1')
        `);
            await run(sql`
            INSERT INTO folder_export_configurations (id, user_id, folder_id, provider)
            VALUES ('c1', 'u1', 'f1', 'filesystem')
        `);
            await run(sql`
            INSERT INTO folder_export_placements (
                id, user_id, export_configuration_id, recording_id,
                placement_folder_id, target_path, directory_name, logical_path
            ) VALUES ('pl1', 'u1', 'c1', 'r1', 'f1', 't', 'd', 'l')
        `);
            await run(sql`
            INSERT INTO folder_export_materializations (
                id, user_id, export_configuration_id, recording_id,
                placement_folder_id, artifact_type, artifact_id,
                artifact_version, logical_path, expected_size
            ) VALUES ('m1', 'u1', 'c1', 'r1', 'f1', 'audio', 'r1', 'v', 'l/a', 1)
        `);
            await run(sql`
            INSERT INTO transcriptions (id, recording_id, user_id, text, provider, model)
            VALUES ('t1', 'r1', 'u1', 'enc:text', 'openai', 'whisper-1')
        `);
            await run(sql`
            INSERT INTO people (id, user_id, display_name)
            VALUES ('pe1', 'u1', 'enc:Petra')
        `);
            await run(sql`
            INSERT INTO knowledge_facts (
                id, user_id, subject_person_id, relation_key, object_literal,
                subject_key, object_key, origin
            ) VALUES ('kf1', 'u1', 'pe1', 'role', 'enc:lead', 'p:pe1', 'l:x', 'recording')
        `);
            await run(sql`
            INSERT INTO knowledge_fact_evidence (
                id, user_id, fact_id, transcription_id, recording_id,
                transcript_revision, start_ms, end_ms, quote
            ) VALUES ('e1', 'u1', 'kf1', 't1', 'r1', 0, 0, 1000, 'enc:q')
        `);
            await run(sql`
            INSERT INTO learn_runs (
                id, user_id, scope_user_id, recording_id, transcription_id,
                view, trigger, transcript_revision, vocabulary_version
            ) VALUES ('lr1', 'u1', 'u1', 'r1', 't1', 'private', 'manual', 0, 0)
        `);
            await run(sql`
            INSERT INTO transcript_correction_passes (
                id, user_id, scope_user_id, recording_id, transcription_id,
                transcript_revision, view
            ) VALUES ('cp1', 'u1', 'u1', 'r1', 't1', 0, 'private')
        `);
            await run(sql`
            INSERT INTO learn_dismissals (id, user_id, recording_id, fingerprint_hmac)
            VALUES ('ld1', 'u1', 'r1', 'fp')
        `);
            await run(sql`
            INSERT INTO ai_enhancements (id, recording_id, user_id, provider, model)
            VALUES ('ae1', 'r1', 'u1', 'openai', 'gpt')
        `);
            await run(sql`
            INSERT INTO recording_tasks (id, recording_id, user_id, status, text, source)
            VALUES ('rt1', 'r1', 'u1', 'open', 'enc:do', 'riffado')
        `);
            await run(sql`
            INSERT INTO recording_task_rejections (id, user_id, recording_id, fingerprint_hmac)
            VALUES ('rr1', 'u1', 'r1', 'fp')
        `);
            await run(sql`
            INSERT INTO task_update_proposals (id, task_id, recording_id, user_id, kind)
            VALUES ('tu1', 'rt1', 'r1', 'u1', 'done')
        `);
            await run(sql`
            INSERT INTO ai_usage_events (
                id, recording_id, user_id, payer_user_id, operation, provider, model
            ) VALUES ('au1', 'r1', 'u1', 'u1', 'summary', 'openai', 'gpt')
        `);
            await run(sql`
            INSERT INTO webhook_endpoints (id, user_id, url, secret, events)
            VALUES ('we1', 'u1', 'enc:url', 'enc:secret', '[]'::jsonb)
        `);
            await run(sql`
            INSERT INTO webhook_deliveries (
                id, endpoint_id, user_id, recording_id, event, payload, status
            ) VALUES ('wd1', 'we1', 'u1', 'r1', 'recording.synced', '{}'::jsonb, 'success')
        `);

            for (const table of REFERENCING)
                counts.set(table, await count(table));
            await migrateTestDatabase(testDatabaseUrl ?? "", db());
        }, 240_000);

        afterAll(async () => {
            await database?.dispose();
            if (partialFolder)
                rmSync(partialFolder, { recursive: true, force: true });
        }, 30_000);

        it("seeded a row in every table that references a recording", () => {
            for (const table of REFERENCING) {
                expect(counts.get(table), table).toBeGreaterThan(0);
            }
        });

        it("makes every recording an audio item with its values", async () => {
            const items = await db().execute<Record<string, unknown>>(sql`
            SELECT id, user_id, kind, title, title_edited_at, occurred_at,
                summary_due_at, content_reaped_at, summary_reaped_at,
                deleted_at, created_at, updated_at
            FROM chatter_items ORDER BY id
        `);
            expect(items.map((row) => row.id)).toEqual(["r1", "r2", "r3"]);
            const [one, two, three] = items;
            expect(one).toMatchObject({
                user_id: "u1",
                kind: "audio",
                title: "enc:one",
                deleted_at: null,
            });
            expect(String(one?.occurred_at)).toContain("2026-09-01");
            expect(one?.title_edited_at).not.toBeNull();
            expect(one?.summary_due_at).not.toBeNull();
            expect(one?.content_reaped_at).not.toBeNull();
            expect(one?.summary_reaped_at).not.toBeNull();
            expect(two?.deleted_at).not.toBeNull();
            expect(three).toMatchObject({ user_id: "u2", title: "enc:three" });
        });

        it("keeps every row that pointed at a recording", async () => {
            for (const table of REFERENCING) {
                expect(await count(table), table).toBe(counts.get(table));
            }
        });

        it("refuses a recording without an item of its owner", async () => {
            await expect(
                db().execute(sql`
                INSERT INTO recordings (
                    id, user_id, device_sn, plaud_file_id, duration,
                    end_time, filesize, file_md5, storage_type, storage_path,
                    plaud_version
                ) VALUES ('r4', 'u2', 'SN', 'p4', 1, now(), 1,
                    ${"0".repeat(32)}, 'local', 'u2/r4.mp3', '1')
            `),
            ).rejects.toThrow();
            await db().execute(sql`
            INSERT INTO chatter_items (id, user_id, kind, title, occurred_at)
            VALUES ('r5', 'u1', 'audio', 'enc:five', now())
        `);
            await expect(
                db().execute(sql`
                INSERT INTO recordings (
                    id, user_id, device_sn, plaud_file_id, duration,
                    end_time, filesize, file_md5, storage_type, storage_path,
                    plaud_version
                ) VALUES ('r5', 'u2', 'SN', 'p5', 1, now(), 1,
                    ${"0".repeat(32)}, 'local', 'u2/r5.mp3', '1')
            `),
            ).rejects.toThrow();
        });

        it("refuses a recording under a mail item", async () => {
            await db().execute(sql`
            INSERT INTO chatter_items (id, user_id, kind, title, occurred_at)
            VALUES ('m1', 'u1', 'mail', 'enc:subject', now())
        `);
            await expect(
                db().execute(sql`
                INSERT INTO recordings (
                    id, user_id, device_sn, plaud_file_id, duration,
                    end_time, filesize, file_md5, storage_type, storage_path,
                    plaud_version
                ) VALUES ('m1', 'u1', 'SN', 'pm1', 1, now(), 1,
                    ${"0".repeat(32)}, 'local', 'u1/m1.mp3', '1')
            `),
            ).rejects.toThrow();
        });

        it("refuses a task on no item", async () => {
            await expect(
                db().execute(sql`
                INSERT INTO recording_tasks (id, recording_id, user_id, status, text, source)
                VALUES ('rt2', 'nowhere', 'u1', 'open', 'enc:do', 'riffado')
            `),
            ).rejects.toThrow();
        });

        it("takes the recording and everything on it when its item goes", async () => {
            await db().execute(sql`DELETE FROM chatter_items WHERE id = 'r1'`);
            const rows = await db().execute<{ n: number }>(
                sql`SELECT count(*)::int AS n FROM recordings WHERE id = 'r1'`,
            );
            expect(rows[0]?.n).toBe(0);
            for (const table of REFERENCING) {
                const left = await db().execute<{ n: number }>(
                    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE recording_id = 'r1'`,
                );
                expect(left[0]?.n, table).toBe(0);
            }
        });
    },
);
