/**
 * What sharing and withdrawing a recording do to the knowledge on it.
 *
 * A shared recording is one recording, with one set of transcripts, so
 * nothing is copied to another transcript: knowledge changes scope on the
 * same one.
 *
 * - **Sharing** publishes the owner's corrections on the recording and the
 *   heard-as forms they taught to the Organization's scope, and states the
 *   owner's facts said there in the Organization's scope too, with
 *   Organization evidence beside the owner's. What names a private person
 *   or entity promotes them first, and the owner's private types it needs
 *   are adopted (`adoptTypesForShareInTx`). What cannot be shared stays
 *   private and is counted, and publishes nothing, not even whom it names:
 *   a relation the people or entities do not fit once promoted, a type
 *   whose name the deny list refuses now, or a single-valued fact the
 *   Organization already knows otherwise (the Organization's knowledge is
 *   not overwritten by a share).
 * - **Withdrawal** takes back everything the Organization derived from the
 *   recording: its evidence there goes, and a fact of its left without any
 *   is pruned. The corrections on the transcripts, and the heard-as forms
 *   they taught, return to the owner's scope: the owner gets the recording
 *   back as the Organization left it, which is what they saw of it all
 *   along. An owner's correction that waited unpublished goes where an
 *   Organization one covers the same words, and returns otherwise.
 *   Promoted people and entities stay the Organization's.
 *
 * Both run inside the transaction that shares or withdraws, under the
 * Organization-people lock and the recording lock, and return the scopes
 * they touched for the caller to bump at its end.
 */

import {
    and,
    asc,
    desc,
    eq,
    exists,
    inArray,
    isNotNull,
    isNull,
    lt,
    or,
    type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { db } from "@/db";
import {
    knowledgeAliases,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    learnDismissals,
    learnRuns,
    transcriptCorrections,
    transcriptions,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import {
    planEntityPromotionInTx,
    promoteEntityInTx,
} from "@/lib/knowledge/entities";
import { pruneUnsupportedFactsInTx } from "@/lib/knowledge/fact-evidence";
import { nodeKey, relationFits } from "@/lib/knowledge/fact-rules";
import {
    confirmFactInTx,
    type FactObject,
    findUsableRelationInTx,
    objectKeyOf,
} from "@/lib/knowledge/facts";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";
import {
    planPersonPromotionInTx,
    promotePersonInTx,
} from "@/lib/knowledge/people";
import { scopesNamingInTx } from "@/lib/knowledge/scope-generation";
import {
    adoptTypesForShareInTx,
    dropUnusedAdoptionsInTx,
} from "@/lib/knowledge/vocabulary";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface PublishedKnowledge {
    corrections: number;
    facts: number;
    /** Left private: nothing of them could be shared. */
    privateCorrections: number;
    privateFacts: number;
    scopes: Set<string>;
}

async function transcriptIdsOf(tx: Tx, recordingId: string) {
    const rows = await tx
        .select({ id: transcriptions.id })
        .from(transcriptions)
        .where(eq(transcriptions.recordingId, recordingId));
    return rows.map((row) => row.id);
}

/**
 * SQL on `knowledge_fact_evidence`: evidence on the item, in one of its
 * transcripts (a recording) or in its text (a mail).
 */
function evidenceOnItem(itemId: string, transcriptIds: readonly string[]): SQL {
    const inText = and(
        eq(knowledgeFactEvidence.itemId, itemId),
        isNotNull(knowledgeFactEvidence.segmentIndex),
    ) as SQL;
    return transcriptIds.length > 0
        ? (or(
              inArray(knowledgeFactEvidence.transcriptionId, [
                  ...transcriptIds,
              ]),
              inText,
          ) as SQL)
        : inText;
}

/**
 * The Organization's id for a person or entity, promoting a private one;
 * null when it cannot be shared (an entity of a private type not adopted).
 */
async function sharedTargetInTx(
    tx: Tx,
    target: KnowledgeTarget,
    orgUserId: string,
): Promise<KnowledgeTarget | null> {
    if ("personId" in target) {
        const id = await promotePersonInTx(tx, target.personId, orgUserId);
        return id ? { personId: id } : null;
    }
    try {
        const id = await promoteEntityInTx(tx, target.entityId, orgUserId);
        return id ? { entityId: id } : null;
    } catch (error) {
        if (
            error instanceof AppError &&
            error.details?.reason === "entityTypePrivate"
        ) {
            return null;
        }
        throw error;
    }
}

function node(
    personId: string | null,
    entityId: string | null,
): KnowledgeTarget {
    return personId ? { personId } : { entityId: entityId ?? "" };
}

/**
 * The key an Organization relation takes for `key`: core and
 * Organization keys as they are, a private one by its adoption, or null.
 */
async function sharedRelationKeyInTx(
    tx: Tx,
    key: string,
    ownerUserId: string,
): Promise<string | null> {
    const [relation] = await tx
        .select({
            userId: knowledgeRelationTypes.userId,
            adoptedAsKey: knowledgeRelationTypes.adoptedAsKey,
            orgOwned: orgOwnedCondition(knowledgeRelationTypes.userId),
        })
        .from(knowledgeRelationTypes)
        .where(eq(knowledgeRelationTypes.key, key))
        .limit(1);
    if (!relation) return null;
    if (relation.userId === null || relation.orgOwned) return key;
    if (relation.userId === ownerUserId) return relation.adoptedAsKey;
    return null;
}

export async function publishKnowledgeInTx(
    tx: Tx,
    {
        recordingId,
        ownerUserId,
        orgUserId,
    }: { recordingId: string; ownerUserId: string; orgUserId: string },
): Promise<PublishedKnowledge> {
    const result: PublishedKnowledge = {
        corrections: 0,
        facts: 0,
        privateCorrections: 0,
        privateFacts: 0,
        scopes: new Set([ownerUserId, orgUserId]),
    };
    const transcriptIds = await transcriptIdsOf(tx, recordingId);
    const onItem = evidenceOnItem(recordingId, transcriptIds);
    // A mail has no transcript, and so no corrections.
    const corrections =
        transcriptIds.length > 0
            ? await tx
                  .select({
                      id: transcriptCorrections.id,
                      kind: transcriptCorrections.kind,
                      targetPersonId: transcriptCorrections.targetPersonId,
                      targetEntityId: transcriptCorrections.targetEntityId,
                  })
                  .from(transcriptCorrections)
                  .where(
                      and(
                          inArray(
                              transcriptCorrections.transcriptionId,
                              transcriptIds,
                          ),
                          eq(transcriptCorrections.userId, ownerUserId),
                      ),
                  )
            : [];
    const facts = await tx
        .selectDistinct({
            id: knowledgeFacts.id,
            subjectPersonId: knowledgeFacts.subjectPersonId,
            subjectEntityId: knowledgeFacts.subjectEntityId,
            relationKey: knowledgeFacts.relationKey,
            objectPersonId: knowledgeFacts.objectPersonId,
            objectEntityId: knowledgeFacts.objectEntityId,
            objectLiteral: knowledgeFacts.objectLiteral,
        })
        .from(knowledgeFacts)
        .innerJoin(
            knowledgeFactEvidence,
            eq(knowledgeFactEvidence.factId, knowledgeFacts.id),
        )
        .where(
            and(
                eq(knowledgeFacts.userId, ownerUserId),
                isNull(knowledgeFacts.replacedByFactId),
                onItem,
                eq(knowledgeFactEvidence.status, "supported"),
            ),
        );
    if (corrections.length === 0 && facts.length === 0) return result;

    // The owner's private types what it names needs become the
    // Organization's first (Johnny, 2026-09-29), so it all publishes.
    const adopted = await adoptTypesForShareInTx(tx, {
        ownerUserId,
        orgUserId,
        entityIds: [
            ...corrections.map((row) => row.targetEntityId),
            ...facts.flatMap((row) => [
                row.subjectEntityId,
                row.objectEntityId,
            ]),
        ].filter((id): id is string => Boolean(id)),
        relationKeys: [...new Set(facts.map((row) => row.relationKey))],
    });

    // Everyone naming what may be promoted, read before it is.
    for (const scope of await scopesNamingInTx(tx, {
        personIds: [
            ...corrections.map((row) => row.targetPersonId),
            ...facts.flatMap((row) => [
                row.subjectPersonId,
                row.objectPersonId,
            ]),
        ].filter((id): id is string => Boolean(id)),
        entityIds: [
            ...corrections.map((row) => row.targetEntityId),
            ...facts.flatMap((row) => [
                row.subjectEntityId,
                row.objectEntityId,
            ]),
        ].filter((id): id is string => Boolean(id)),
    })) {
        result.scopes.add(scope);
    }

    for (const correction of corrections) {
        const named =
            correction.targetPersonId !== null ||
            correction.targetEntityId !== null;
        const target = named
            ? await sharedTargetInTx(
                  tx,
                  node(correction.targetPersonId, correction.targetEntityId),
                  orgUserId,
              )
            : null;
        // A correction pass's fix is the words put right: it is shared
        // with its record where that can be, else on its own.
        if (!target && correction.kind !== "fix") {
            result.privateCorrections++;
            continue;
        }
        let columns: {
            targetPersonId: string | null;
            targetEntityId: string | null;
        } = { targetPersonId: null, targetEntityId: null };
        if (target && "personId" in target) {
            columns = { targetPersonId: target.personId, targetEntityId: null };
        } else if (target) {
            columns = { targetPersonId: null, targetEntityId: target.entityId };
        }
        await tx
            .update(transcriptCorrections)
            .set({ userId: orgUserId, ...columns, updatedAt: new Date() })
            .where(eq(transcriptCorrections.id, correction.id));
        await tx
            .update(knowledgeAliases)
            .set({
                userId: orgUserId,
                personId: columns.targetPersonId,
                entityId: columns.targetEntityId,
                updatedAt: new Date(),
            })
            .where(eq(knowledgeAliases.correctionId, correction.id));
        result.corrections++;
    }

    for (const fact of facts) {
        const shared = await publishFactInTx(tx, fact, {
            ownerUserId,
            orgUserId,
            onItem,
            origin: transcriptIds.length > 0 ? "recording" : "mail",
        });
        if (shared) result.facts++;
        else result.privateFacts++;
    }
    // A type adopted for what then stayed private is not the curator's.
    await dropUnusedAdoptionsInTx(tx, adopted);
    return result;
}

/**
 * What a person or an entity would be in the Organization's scope, and its
 * type, decided without writing (`planPersonPromotionInTx`,
 * `planEntityPromotionInTx`): null when it cannot be shared.
 */
async function shareableTargetInTx(
    tx: Tx,
    target: KnowledgeTarget,
    orgUserId: string,
): Promise<{ target: KnowledgeTarget; type: string } | null> {
    if ("personId" in target) {
        const plan = await planPersonPromotionInTx(
            tx,
            target.personId,
            orgUserId,
        );
        return plan
            ? { target: { personId: plan.orgPersonId }, type: "person" }
            : null;
    }
    const plan = await planEntityPromotionInTx(tx, target.entityId, orgUserId);
    if (!plan || plan.kind === "private") return null;
    return { target: { entityId: plan.orgEntityId }, type: plan.typeKey };
}

/**
 * One of the owner's facts, stated in the Organization's scope; see above.
 *
 * Decided before anything is written, so a fact that stays private
 * publishes nothing, not even whom it names: the relation the Organization
 * would use, the people and entities it would name once promoted, that
 * they fit the relation, and the Organization's current value of a
 * single-valued relation. The share holds the Organization-people lock,
 * which every other writer of the Organization's knowledge takes too, so
 * what was decided still holds when it is written.
 */
async function publishFactInTx(
    tx: Tx,
    fact: {
        id: string;
        subjectPersonId: string | null;
        subjectEntityId: string | null;
        relationKey: string;
        objectPersonId: string | null;
        objectEntityId: string | null;
        objectLiteral: string | null;
    },
    {
        ownerUserId,
        orgUserId,
        onItem,
        origin,
    }: {
        ownerUserId: string;
        orgUserId: string;
        /** `evidenceOnItem` of the item shared. */
        onItem: SQL;
        origin: "recording" | "mail";
    },
): Promise<boolean> {
    const relationKey = await sharedRelationKeyInTx(
        tx,
        fact.relationKey,
        ownerUserId,
    );
    const relation = relationKey
        ? await findUsableRelationInTx(tx, orgUserId, relationKey)
        : null;
    if (!relation) return false;
    const subjectNode = node(fact.subjectPersonId, fact.subjectEntityId);
    const objectNode = node(fact.objectPersonId, fact.objectEntityId);
    const subject = await shareableTargetInTx(tx, subjectNode, orgUserId);
    if (!subject) return false;
    const literal = fact.objectLiteral ? decryptText(fact.objectLiteral) : null;
    const object =
        literal === null
            ? await shareableTargetInTx(tx, objectNode, orgUserId)
            : null;
    if (literal === null && !object) return false;
    const fits = relationFits(
        {
            subjectTypes: relation.subjectTypes,
            objectTypes: relation.objectTypes,
            objectKind: relation.objectKind as "entity" | "literal",
        },
        subject.type,
        object ? { type: object.type } : { literal: true },
    );
    if (!fits) return false;

    // The Organization's knowledge is not overwritten by a share: where it
    // holds another current value of a single-valued relation, the fact
    // stays private. The same value gains this recording's evidence.
    let expectedCurrentFactId: string | null = null;
    if (relation.cardinality === "one") {
        const [current] = await tx
            .select({
                id: knowledgeFacts.id,
                objectKey: knowledgeFacts.objectKey,
            })
            .from(knowledgeFacts)
            .where(
                and(
                    eq(knowledgeFacts.userId, orgUserId),
                    eq(knowledgeFacts.subjectKey, nodeKey(subject.target)),
                    eq(knowledgeFacts.relationKey, relation.key),
                    isNull(knowledgeFacts.replacedByFactId),
                ),
            )
            .orderBy(desc(knowledgeFacts.updatedAt), asc(knowledgeFacts.id))
            .limit(1);
        if (current) {
            const objectKey = objectKeyOf(
                object ? object.target : { literal: literal ?? "" },
            );
            if (current.objectKey !== objectKey) return false;
            expectedCurrentFactId = current.id;
        }
    }

    // Decided: now promote whom it names, and state it there.
    const sharedSubject = await sharedTargetInTx(tx, subjectNode, orgUserId);
    const sharedObject: FactObject | null =
        literal === null
            ? await sharedTargetInTx(tx, objectNode, orgUserId)
            : { literal };
    if (!sharedSubject || !sharedObject) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "What the share named changed meanwhile; try again",
            409,
        );
    }
    const orgFactId = await confirmFactInTx(tx, {
        scopeUserId: orgUserId,
        actorUserId: ownerUserId,
        origin,
        subject: sharedSubject,
        relationKey: relation.key,
        object: sharedObject,
        expectedCurrentFactId,
    });
    const evidence = await tx
        .select()
        .from(knowledgeFactEvidence)
        .where(
            and(
                eq(knowledgeFactEvidence.factId, fact.id),
                onItem,
                eq(knowledgeFactEvidence.status, "supported"),
            ),
        );
    if (evidence.length > 0) {
        await tx
            .insert(knowledgeFactEvidence)
            .values(
                evidence.map(({ id: _id, ...row }) => ({
                    ...row,
                    userId: orgUserId,
                    factId: orgFactId,
                })),
            )
            .onConflictDoNothing();
    }
    return true;
}

/** Take back what the Organization derived from the recording; see above. */
export async function withdrawKnowledgeInTx(
    tx: Tx,
    {
        recordingId,
        ownerUserId,
        orgUserId,
    }: { recordingId: string; ownerUserId: string; orgUserId: string },
): Promise<Set<string>> {
    const scopes = new Set([ownerUserId, orgUserId]);
    // The Organization's Learn runs there, and what they proposed and
    // were told no to: its view of the recording is gone.
    await tx
        .delete(learnRuns)
        .where(
            and(
                eq(learnRuns.itemId, recordingId),
                eq(learnRuns.scopeUserId, orgUserId),
            ),
        );
    await tx
        .delete(learnDismissals)
        .where(
            and(
                eq(learnDismissals.itemId, recordingId),
                eq(learnDismissals.userId, orgUserId),
            ),
        );

    const transcriptIds = await transcriptIdsOf(tx, recordingId);
    const removed = await tx
        .delete(knowledgeFactEvidence)
        .where(
            and(
                evidenceOnItem(recordingId, transcriptIds),
                eq(knowledgeFactEvidence.userId, orgUserId),
            ),
        )
        .returning({ factId: knowledgeFactEvidence.factId });
    await pruneUnsupportedFactsInTx(tx, [
        ...new Set(removed.map((row) => row.factId)),
    ]);
    // A mail has no transcript, and so no corrections to give back.
    if (transcriptIds.length === 0) return scopes;

    // The owner's corrections that waited while shared give way where the
    // Organization's returning ones cover the same words (their heard-as
    // forms go with them).
    const returning = alias(transcriptCorrections, "returning");
    await tx.delete(transcriptCorrections).where(
        and(
            inArray(transcriptCorrections.transcriptionId, transcriptIds),
            eq(transcriptCorrections.userId, ownerUserId),
            exists(
                tx
                    .select({ id: returning.id })
                    .from(returning)
                    .where(
                        and(
                            eq(returning.userId, orgUserId),
                            eq(
                                returning.transcriptionId,
                                transcriptCorrections.transcriptionId,
                            ),
                            eq(
                                returning.turnIndex,
                                transcriptCorrections.turnIndex,
                            ),
                            lt(
                                returning.charStart,
                                transcriptCorrections.charEnd,
                            ),
                            lt(
                                transcriptCorrections.charStart,
                                returning.charEnd,
                            ),
                        ),
                    ),
            ),
        ),
    );
    const corrections = await tx
        .update(transcriptCorrections)
        .set({ userId: ownerUserId, updatedAt: new Date() })
        .where(
            and(
                inArray(transcriptCorrections.transcriptionId, transcriptIds),
                eq(transcriptCorrections.userId, orgUserId),
            ),
        )
        .returning({ id: transcriptCorrections.id });
    if (corrections.length > 0) {
        await tx
            .update(knowledgeAliases)
            .set({ userId: ownerUserId, updatedAt: new Date() })
            .where(
                and(
                    inArray(
                        knowledgeAliases.correctionId,
                        corrections.map((row) => row.id),
                    ),
                    eq(knowledgeAliases.userId, orgUserId),
                ),
            );
    }
    return scopes;
}
