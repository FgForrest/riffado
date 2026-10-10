/**
 * Whether automatic Learn holds a recording's title, summary and topics
 * back (Task 5.5). Only the schema and the database: the jobs that make
 * them check it before running, so a job queued before a newer hold
 * began never works from a transcript nobody reviewed yet.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, transcriptions } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function isHeldForLearn(recordingId: string): Promise<boolean> {
    const [held] = await db
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                isNotNull(chatterItems.summaryDueAt),
            ),
        )
        .limit(1);
    return held !== undefined;
}

/**
 * Drop a recording's hold where what it waited for is gone: a new Riffado
 * transcript (in the transaction that writes it), an erased transcript, a
 * deleted recording. Nothing is queued: whatever replaced it decides.
 */
export async function clearAutoLearnHoldInTx(
    tx: Tx,
    recordingId: string,
): Promise<void> {
    await tx
        .update(chatterItems)
        .set({ summaryDueAt: null })
        .where(
            and(
                eq(chatterItems.id, recordingId),
                isNotNull(chatterItems.summaryDueAt),
            ),
        );
}

/** The recording of a Riffado transcript, for `clearAutoLearnHoldInTx`. */
export async function riffadoRecordingOfInTx(
    tx: Tx,
    transcriptionId: string,
): Promise<string | null> {
    const [row] = await tx
        .select({ recordingId: transcriptions.recordingId })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.id, transcriptionId),
                eq(transcriptions.source, "riffado"),
            ),
        )
        .limit(1);
    return row?.recordingId ?? null;
}
