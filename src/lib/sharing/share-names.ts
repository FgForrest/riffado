import { and, eq, inArray, sql } from "drizzle-orm";
import type { db } from "@/db";
import {
    people,
    recordingTasks,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";
import { promotePersonInTx } from "@/lib/knowledge/people";
import { scopesNamingInTx } from "@/lib/knowledge/scope-generation";
import { transcriptSpeakerLabels } from "@/lib/knowledge/speaker-labels";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Make a recording's speaker names the Organization's, as it is shared.
 *
 * A shared recording is one recording, read by everyone in the
 * Organization, so every person confirmed on its transcripts becomes an
 * Organization person (`promotePersonInTx`: the same record, moved, or
 * folded into the Organization's person with the same email). Suggestions
 * naming someone who is still private are machine guesses the organization
 * account, which reviews suggestions, must not see; they go. So do rows on
 * labels the text no longer has: nobody sees them, the gate never judged
 * them, and a private person on one must not be published by it.
 *
 * The caller holds the Organization-people lock and then the recording
 * lock, in that order: a promotion may merge people, which locks the
 * recordings naming them. Returns how many people were promoted, and the
 * knowledge scopes the change reached, for the caller to bump at its end.
 */
export async function publishSpeakerNamesInTx(
    tx: Tx,
    {
        recordingId,
        ownerUserId,
        orgUserId,
    }: { recordingId: string; ownerUserId: string; orgUserId: string },
): Promise<{ promoted: number; scopes: Set<string> }> {
    const transcripts = await tx
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
        );
    if (transcripts.length === 0) return { promoted: 0, scopes: new Set() };
    // The labels each text has now, as the gate reads them.
    const current = new Map(
        transcripts.map((transcript) => [
            transcript.id,
            new Set(transcriptSpeakerLabels(transcript)),
        ]),
    );

    const rows = await tx
        .select({
            id: transcriptSpeakers.id,
            transcriptionId: transcriptSpeakers.transcriptionId,
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            status: transcriptSpeakers.status,
            orgPerson: sql<boolean>`coalesce(${orgOwnedCondition(people.userId)}, false)`,
        })
        .from(transcriptSpeakers)
        .leftJoin(people, eq(people.id, transcriptSpeakers.personId))
        .where(
            inArray(
                transcriptSpeakers.transcriptionId,
                transcripts.map((transcript) => transcript.id),
            ),
        );

    const dropped: string[] = [];
    const toPromote = new Set<string>();
    for (const row of rows) {
        if (!current.get(row.transcriptionId)?.has(row.label)) {
            dropped.push(row.id);
        } else if (!row.personId || row.orgPerson) {
            // Nobody named, or somebody the Organization knows already.
        } else if (row.status === "confirmed") {
            toPromote.add(row.personId);
        } else {
            dropped.push(row.id);
        }
    }
    if (dropped.length > 0) {
        await tx
            .delete(transcriptSpeakers)
            .where(inArray(transcriptSpeakers.id, dropped));
    }
    // Read before promoting: the people move from the owner's scope to the
    // Organization's, and their notes to overlays.
    const scopes = await scopesNamingInTx(tx, { personIds: [...toPromote] });
    let promoted = 0;
    for (const personId of toPromote) {
        if (await promotePersonInTx(tx, personId, orgUserId)) promoted += 1;
    }
    scopes.add(orgUserId);
    return { promoted, scopes };
}

/**
 * Make the people a recording's tasks are assigned to the Organization's,
 * as it is shared: a shared task names someone everyone can see, and the
 * assignee finds it in their list. Same promotion, and the same locks
 * held by the caller, as `publishSpeakerNamesInTx`. Returns the scopes the
 * change reached, for the caller to bump.
 */
export async function publishTaskAssigneesInTx(
    tx: Tx,
    { recordingId, orgUserId }: { recordingId: string; orgUserId: string },
): Promise<Set<string>> {
    const rows = await tx
        .selectDistinct({ personId: recordingTasks.assigneePersonId })
        .from(recordingTasks)
        .innerJoin(people, eq(people.id, recordingTasks.assigneePersonId))
        .where(
            and(
                eq(recordingTasks.itemId, recordingId),
                sql`not ${orgOwnedCondition(people.userId)}`,
            ),
        );
    // From now on its assignees see these tasks: news for their badge.
    await tx
        .update(recordingTasks)
        .set({ assignedAt: new Date() })
        .where(
            and(
                eq(recordingTasks.itemId, recordingId),
                eq(recordingTasks.status, "open"),
                sql`${recordingTasks.assigneePersonId} is not null`,
            ),
        );
    const personIds = rows.flatMap((row) =>
        row.personId ? [row.personId] : [],
    );
    if (personIds.length === 0) return new Set();
    const scopes = await scopesNamingInTx(tx, { personIds });
    for (const personId of personIds) {
        const promoted = await promotePersonInTx(tx, personId, orgUserId);
        if (promoted && promoted !== personId) {
            await tx
                .update(recordingTasks)
                .set({ assigneePersonId: promoted })
                .where(eq(recordingTasks.assigneePersonId, personId));
        }
    }
    scopes.add(orgUserId);
    return scopes;
}
