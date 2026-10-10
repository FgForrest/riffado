/**
 * The facts a People or entity page shows about one person or entity: the
 * current ones the viewer may read (their own scope's and the
 * Organization's), grouped by relation, each with the other side's name,
 * and where it was said, from evidence on recordings the viewer can open.
 */

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import {
    chatterItems,
    knowledgeEntities,
    knowledgeFactEvidence,
    knowledgeFacts,
    people,
    recordings,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import { entitiesVisibleTo } from "@/lib/knowledge/entities";
import {
    orgOwnedCondition,
    visibleOwnerCondition,
} from "@/lib/knowledge/org-people";
import { peopleVisibleTo } from "@/lib/knowledge/people";
import { vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";
import { sharedRecordingCondition } from "@/lib/sharing/shared";

export interface FactSide {
    kind: "person" | "entity" | "literal";
    /** Absent for text. */
    id?: string;
    text: string;
}

export interface PageEvidence {
    recordingId: string;
    title: string;
    /** When the recording began, ISO 8601. */
    recordedAt: string;
    /** Where in the recording; null for evidence in a mail. */
    startMs: number | null;
    /** Where the viewer opens it: their own, or the Organization's view. */
    view: "private" | "org";
}

export interface PageFact {
    id: string;
    /** Whether the page's person or entity is the fact's subject. */
    direction: "subject" | "object";
    other: FactSide;
    scope: "personal" | "org";
    origin: "recording" | "mail" | "manual";
    evidence: PageEvidence[];
}

export interface PageRelation {
    key: string;
    label: string;
    facts: PageFact[];
}

function nodeOf(personId: string | null, entityId: string | null) {
    return personId
        ? { kind: "person" as const, id: personId }
        : { kind: "entity" as const, id: entityId ?? "" };
}

/** The facts about `target` that `viewerUserId` may read, by relation. */
export async function factsForPage(
    viewerUserId: string,
    orgUserId: string | null,
    target: KnowledgeTarget,
): Promise<PageRelation[]> {
    const about =
        "personId" in target
            ? or(
                  eq(knowledgeFacts.subjectPersonId, target.personId),
                  eq(knowledgeFacts.objectPersonId, target.personId),
              )
            : or(
                  eq(knowledgeFacts.subjectEntityId, target.entityId),
                  eq(knowledgeFacts.objectEntityId, target.entityId),
              );
    const facts = await db
        .select({
            id: knowledgeFacts.id,
            ownerIsOrg: orgOwnedCondition(knowledgeFacts.userId),
            subjectPersonId: knowledgeFacts.subjectPersonId,
            subjectEntityId: knowledgeFacts.subjectEntityId,
            relationKey: knowledgeFacts.relationKey,
            objectPersonId: knowledgeFacts.objectPersonId,
            objectEntityId: knowledgeFacts.objectEntityId,
            objectLiteral: knowledgeFacts.objectLiteral,
            origin: knowledgeFacts.origin,
        })
        .from(knowledgeFacts)
        .where(
            and(
                about,
                isNull(knowledgeFacts.replacedByFactId),
                visibleOwnerCondition(knowledgeFacts.userId, viewerUserId),
            ),
        );
    if (facts.length === 0) return [];

    // Where they were said, on recordings the viewer can open: their own,
    // or shared ones.
    const evidence = await db
        .select({
            factId: knowledgeFactEvidence.factId,
            recordingId: recordings.id,
            recordingOwner: recordings.userId,
            title: chatterItems.title,
            startTime: chatterItems.occurredAt,
            startMs: knowledgeFactEvidence.startMs,
        })
        .from(knowledgeFactEvidence)
        .innerJoin(recordings, eq(recordings.id, knowledgeFactEvidence.itemId))
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                inArray(
                    knowledgeFactEvidence.factId,
                    facts.map((fact) => fact.id),
                ),
                eq(knowledgeFactEvidence.status, "supported"),
                isNull(recordings.deletedAt),
                or(
                    eq(recordings.userId, viewerUserId),
                    orgUserId ? sharedRecordingCondition(orgUserId) : undefined,
                ),
            ),
        );
    const evidenceByFact = new Map<string, PageEvidence[]>();
    for (const row of evidence) {
        const list = evidenceByFact.get(row.factId) ?? [];
        if (
            !list.some(
                (item) =>
                    item.recordingId === row.recordingId &&
                    item.startMs === row.startMs,
            )
        ) {
            list.push({
                recordingId: row.recordingId,
                title: decryptText(row.title),
                recordedAt: row.startTime.toISOString(),
                startMs: row.startMs,
                view: row.recordingOwner === viewerUserId ? "private" : "org",
            });
        }
        evidenceByFact.set(row.factId, list);
    }

    const sides = facts.map((fact) => {
        const subject = nodeOf(fact.subjectPersonId, fact.subjectEntityId);
        const isSubject =
            "personId" in target
                ? subject.kind === "person" && subject.id === target.personId
                : subject.kind === "entity" && subject.id === target.entityId;
        return {
            fact,
            direction: isSubject ? ("subject" as const) : ("object" as const),
            other: isSubject
                ? fact.objectLiteral
                    ? null
                    : nodeOf(fact.objectPersonId, fact.objectEntityId)
                : subject,
        };
    });
    const personIds = sides.flatMap((side) =>
        side.other?.kind === "person" ? [side.other.id] : [],
    );
    const entityIds = sides.flatMap((side) =>
        side.other?.kind === "entity" ? [side.other.id] : [],
    );
    const [personRows, entityRows, vocabulary] = await Promise.all([
        personIds.length > 0
            ? db
                  .select({ id: people.id, name: people.displayName })
                  .from(people)
                  .where(
                      and(
                          inArray(people.id, personIds),
                          peopleVisibleTo(viewerUserId),
                      ),
                  )
            : [],
        entityIds.length > 0
            ? db
                  .select({
                      id: knowledgeEntities.id,
                      name: knowledgeEntities.name,
                  })
                  .from(knowledgeEntities)
                  .where(
                      and(
                          inArray(knowledgeEntities.id, entityIds),
                          entitiesVisibleTo(viewerUserId),
                      ),
                  )
            : [],
        vocabularyVisibleTo(viewerUserId),
    ]);
    const names = new Map(
        [...personRows, ...entityRows].map((row) => [
            row.id,
            decryptText(row.name),
        ]),
    );
    const labels = new Map(
        vocabulary.relationTypes.map((relation) => [
            relation.key,
            relation.label,
        ]),
    );

    const byRelation = new Map<string, PageRelation>();
    for (const { fact, direction, other } of sides) {
        const evidenceList = evidenceByFact.get(fact.id) ?? [];
        // A fact from recordings shows while the viewer can see it said.
        if (fact.origin === "recording" && evidenceList.length === 0) continue;
        let otherSide: FactSide;
        if (!other) {
            otherSide = {
                kind: "literal",
                text: decryptText(fact.objectLiteral ?? ""),
            };
        } else {
            const name = names.get(other.id);
            // The other side is someone the viewer may not see.
            if (name === undefined) continue;
            otherSide = { kind: other.kind, id: other.id, text: name };
        }
        const relation = byRelation.get(fact.relationKey) ?? {
            key: fact.relationKey,
            label: labels.get(fact.relationKey) ?? fact.relationKey,
            facts: [],
        };
        relation.facts.push({
            id: fact.id,
            direction,
            other: otherSide,
            scope: fact.ownerIsOrg ? "org" : "personal",
            origin: fact.origin,
            evidence: evidenceList.sort((a, b) =>
                b.recordedAt.localeCompare(a.recordedAt),
            ),
        });
        byRelation.set(fact.relationKey, relation);
    }
    return [...byRelation.values()].sort((a, b) =>
        a.label.localeCompare(b.label),
    );
}
