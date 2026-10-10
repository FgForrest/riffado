import type { NewRecording } from "@/db/items";
import { chatterItems, recordings } from "@/db/schema";
import type { TestDatabase } from "@/tests/integration/postgres";

/**
 * A recording as tests describe it: its own columns plus what its item
 * holds, under the names the recording row had before they moved.
 */
export type TestRecordingInsert = NewRecording & {
    id: string;
    filename: string;
    startTime: Date;
    titleEditedAt?: Date | null;
    summaryDueAt?: Date | null;
    transcriptReapedAt?: Date | null;
    summaryReapedAt?: Date | null;
};

/** Inserts recordings with their `audio` items. */
export async function insertRecordings(
    db: Pick<TestDatabase, "insert">,
    rows: TestRecordingInsert | TestRecordingInsert[],
): Promise<void> {
    const list = Array.isArray(rows) ? rows : [rows];
    if (list.length === 0) return;
    await db.insert(chatterItems).values(
        list.map((row) => ({
            id: row.id,
            userId: row.userId,
            kind: "audio" as const,
            title: row.filename,
            titleEditedAt: row.titleEditedAt ?? null,
            occurredAt: row.startTime,
            deletedAt: row.deletedAt ?? null,
            summaryDueAt: row.summaryDueAt ?? null,
            contentReapedAt: row.transcriptReapedAt ?? null,
            summaryReapedAt: row.summaryReapedAt ?? null,
            ...(row.createdAt ? { createdAt: row.createdAt } : {}),
            ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
        })),
    );
    await db
        .insert(recordings)
        .values(
            list.map(
                ({
                    filename: _filename,
                    startTime: _startTime,
                    titleEditedAt: _titleEditedAt,
                    summaryDueAt: _summaryDueAt,
                    transcriptReapedAt: _transcriptReapedAt,
                    summaryReapedAt: _summaryReapedAt,
                    ...recording
                }) => recording,
            ),
        );
}
