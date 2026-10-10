import {
    type Column,
    inArray,
    or,
    type SQL,
    type SQLWrapper,
    sql,
} from "drizzle-orm";
import type { db } from "@/db";
import {
    knowledgeFactEvidence,
    knowledgeFacts,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakerRejections,
    transcriptSpeakers,
    users,
} from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ORG_PEOPLE_LOCK = sql`hashtext('riffado:org-people')`;

const orgAccountIds = sql`array(select ${users.id} from ${users} where ${users.role} = 'org')`;

/**
 * SQL predicate: the row belongs to the organization account.
 *
 * By role rather than by a configured id, so knowledge code needs neither
 * the environment nor the org account's id, and an Organization person
 * keeps resolving if the scope is later switched off. The ids are read
 * once per statement and compared with `= any`, which an index on
 * `column` serves even inside an `or`.
 */
export function orgOwnedCondition(column: Column) {
    return sql`${column} = any(${orgAccountIds})`;
}

/**
 * SQL predicate: the row belongs to `viewerId` or to the organization
 * account, what the viewer sees of a knowledge base. One `= any` over both
 * owners: `viewer or orgOwnedCondition` would scan every account's rows.
 */
export function visibleOwnerCondition(column: Column, viewerId: string) {
    return sql`${column} = any(array[${viewerId}]::text[] || ${orgAccountIds})`;
}

/**
 * SQL predicate: the recording `recordingId` names is filed in the
 * Organization's tree (shared). By role, as above.
 */
export function recordingSharedCondition(recordingId: Column | SQL) {
    return sql`exists (
        select 1
        from ${recordingFolderAssignments}
        inner join ${recordingFolders}
            on ${recordingFolders.id} = ${recordingFolderAssignments.folderId}
        where ${recordingFolderAssignments.itemId} = ${recordingId}
            and ${orgOwnedCondition(recordingFolders.userId)}
    )`;
}

/**
 * Serialize promotions, so two recordings shared at once cannot both create
 * an Organization person for the same email, and a delete or merge cannot
 * act on a private person a share is promoting.
 *
 * Taken before any recording lock: a promotion may merge people, and a
 * merge locks the recordings that name them.
 */
export async function lockOrgPeople(tx: Tx): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(${ORG_PEOPLE_LOCK})`);
}

/**
 * The same lock, shared, for a writer that names a person or an entity
 * (a correction, a fact, an alias, notes, a speaker answer). A merge,
 * promotion or deletion holds it exclusive from before it reads what it
 * moves until it commits, so the writer resolves its target after it and
 * never writes onto a record about to become a tombstone. Writers do not
 * wait for one another. Taken first, before any recording lock, as above.
 */
export async function lockOrgPeopleShared(tx: Tx): Promise<void> {
    await tx.execute(
        sql`select pg_advisory_xact_lock_shared(${ORG_PEOPLE_LOCK})`,
    );
}

function anyOf(column: Column, ids: readonly string[]): SQL {
    return sql`${column} = any(${sql.param(ids)}::text[])`;
}

/**
 * Lock, in id order, the recordings of every transcript that names one of
 * these people or entities: a speaker answer (confirmation or rejection),
 * a correction targeting them, or evidence of a fact naming them. A
 * transcript rewrite takes its recording's lock before it moves those
 * rows, so a merge or a deletion moving or deleting them takes the same
 * lock, shared: it waits for a rewrite in progress and holds off the next
 * one. `factIds` adds the recordings with evidence of those facts. Taken
 * after the Organization-people lock.
 */
export async function lockRecordingsNaming(
    tx: Tx,
    {
        personIds = [],
        entityIds = [],
        factIds = [],
    }: {
        personIds?: readonly string[];
        entityIds?: readonly string[];
        factIds?: readonly string[];
    },
): Promise<void> {
    const namingTranscripts: SQLWrapper[] = [];
    const factNaming: SQL[] = [];
    if (personIds.length > 0) {
        namingTranscripts.push(
            tx
                .select({ id: transcriptSpeakers.transcriptionId })
                .from(transcriptSpeakers)
                .where(anyOf(transcriptSpeakers.personId, personIds)),
            tx
                .select({ id: transcriptSpeakerRejections.transcriptionId })
                .from(transcriptSpeakerRejections)
                .where(anyOf(transcriptSpeakerRejections.personId, personIds)),
            tx
                .select({ id: transcriptCorrections.transcriptionId })
                .from(transcriptCorrections)
                .where(anyOf(transcriptCorrections.targetPersonId, personIds)),
        );
        factNaming.push(
            anyOf(knowledgeFacts.subjectPersonId, personIds),
            anyOf(knowledgeFacts.objectPersonId, personIds),
        );
    }
    if (entityIds.length > 0) {
        namingTranscripts.push(
            tx
                .select({ id: transcriptCorrections.transcriptionId })
                .from(transcriptCorrections)
                .where(anyOf(transcriptCorrections.targetEntityId, entityIds)),
        );
        factNaming.push(
            anyOf(knowledgeFacts.subjectEntityId, entityIds),
            anyOf(knowledgeFacts.objectEntityId, entityIds),
        );
    }
    if (factIds.length > 0) {
        factNaming.push(anyOf(knowledgeFacts.id, factIds));
    }
    if (factNaming.length === 0) return;
    const named =
        namingTranscripts.length > 0
            ? await tx
                  .selectDistinct({ recordingId: transcriptions.recordingId })
                  .from(transcriptions)
                  .where(
                      sql`${transcriptions.id} in (${sql.join(namingTranscripts, sql` union `)})`,
                  )
            : [];
    const evidenced = await tx
        .selectDistinct({ recordingId: knowledgeFactEvidence.itemId })
        .from(knowledgeFactEvidence)
        .where(
            inArray(
                knowledgeFactEvidence.factId,
                tx
                    .select({ id: knowledgeFacts.id })
                    .from(knowledgeFacts)
                    .where(or(...factNaming)),
            ),
        );
    const touched = [
        ...new Set([...named, ...evidenced].map((row) => row.recordingId)),
    ];
    if (touched.length === 0) return;
    await tx
        .select({ id: recordings.id })
        .from(recordings)
        .where(anyOf(recordings.id, touched))
        .orderBy(recordings.id)
        .for("share");
}
