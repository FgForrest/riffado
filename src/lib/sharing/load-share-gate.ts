import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { db } from "@/db";
import {
    learnRuns,
    recordingTasks,
    taskUpdateProposals,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { transcriptSpeakerLabels } from "@/lib/knowledge/speaker-labels";
import { learnRunOpen } from "@/lib/learn/learn-open";
import {
    evaluateShareGate,
    type ShareGateProblem,
} from "@/lib/sharing/share-gate";
import { liveFollowUpCondition } from "@/lib/tasks/store";

type Executor = Pick<typeof db, "select">;

/**
 * The share gate over a recording's transcripts, which its owner holds,
 * and their speaker rows: a shared recording is one recording, so these
 * are exactly what the Organization will read.
 */
export async function loadShareGate(
    executor: Executor,
    recordingId: string,
    ownerUserId: string,
): Promise<ShareGateProblem[]> {
    const transcripts = await executor
        .select({
            id: transcriptions.id,
            source: transcriptions.source,
            model: transcriptions.model,
            text: transcriptions.text,
            turns: transcriptions.turns,
        })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, ownerUserId),
            ),
        )
        .orderBy(asc(transcriptions.source));
    const attributions =
        transcripts.length > 0
            ? await executor
                  .select({
                      transcriptionId: transcriptSpeakers.transcriptionId,
                      label: transcriptSpeakers.label,
                      status: transcriptSpeakers.status,
                      personId: transcriptSpeakers.personId,
                      markedUnknown: transcriptSpeakers.markedUnknown,
                  })
                  .from(transcriptSpeakers)
                  .where(
                      inArray(
                          transcriptSpeakers.transcriptionId,
                          transcripts.map((transcript) => transcript.id),
                      ),
                  )
            : [];
    // The owner's Learn runs not yet finished (in flight with their job
    // alive, or ready for review): what they propose is private until
    // reviewed. A run whose job died holds nothing.
    const [unfinished] = await executor
        .select({ count: sql<number>`count(*)::int` })
        .from(learnRuns)
        .where(
            and(
                eq(learnRuns.itemId, recordingId),
                eq(learnRuns.view, "private"),
                learnRunOpen(),
            ),
        );
    // Proposed tasks are the owner's to settle: once shared, only the
    // Organization changes the recording's tasks.
    const [proposals] = await executor
        .select({ count: sql<number>`count(*)::int` })
        .from(recordingTasks)
        .where(
            and(
                eq(recordingTasks.itemId, recordingId),
                eq(recordingTasks.userId, ownerUserId),
                eq(recordingTasks.status, "proposed"),
            ),
        );
    // So are follow-ups heard on it about earlier tasks, the ones its
    // review shows.
    const [followUps] = await executor
        .select({ count: sql<number>`count(*)::int` })
        .from(taskUpdateProposals)
        .where(
            and(
                eq(taskUpdateProposals.itemId, recordingId),
                eq(taskUpdateProposals.userId, ownerUserId),
                liveFollowUpCondition(),
            ),
        );
    return evaluateShareGate({
        transcripts: transcripts.map((transcript) => ({
            id: transcript.id,
            source: transcript.source,
            labels: transcriptSpeakerLabels(transcript),
        })),
        attributions,
        unfinishedLearnRuns: unfinished?.count ?? 0,
        waitingTaskProposals: (proposals?.count ?? 0) + (followUps?.count ?? 0),
    });
}
