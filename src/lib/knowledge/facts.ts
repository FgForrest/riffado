/**
 * Confirmed facts: subject, relation, object, in a scope (a user's private
 * layer, or the Organization's).
 *
 * A fact from a recording lives while evidence for it does
 * (`fact-evidence.ts`): each piece is a stretch of a transcript's audio
 * time with the words a person confirmed there. A fact entered by hand
 * (`manual`) needs none. A single-valued relation ("works for") holds one
 * object at a time; a new one replaces the current fact, which is kept
 * with `replacedByFactId`.
 *
 * Only a person confirms: nothing here is called with a machine's guess.
 */

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import {
    chatterItems,
    knowledgeEntities,
    knowledgeFactEvidence,
    knowledgeFacts,
    knowledgeRelationTypes,
    mailContents,
    recordings,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import type { ContentSegment } from "@/lib/content/types";
import {
    decryptJsonField,
    decryptText,
    encryptText,
} from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    type KnowledgeTarget,
    resolveTargetInTx,
} from "@/lib/knowledge/aliases";
import { deleteFactsInTx } from "@/lib/knowledge/fact-chains";
import { pruneUnsupportedFactsInTx } from "@/lib/knowledge/fact-evidence";
import {
    nodeKey,
    quoteFromTurns,
    relationFits,
} from "@/lib/knowledge/fact-rules";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import {
    lockOrgPeople,
    lockOrgPeopleShared,
    lockRecordingsNaming,
    recordingSharedCondition,
    visibleOwnerCondition,
} from "@/lib/knowledge/org-people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { speakerLabelsForTranscript } from "@/lib/knowledge/speaker-label-rules";
import { lockTranscriptForChange } from "@/lib/knowledge/transcript-lock";
import { deniedTopicOf } from "@/lib/knowledge/vocabulary-core";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const LITERAL_DOMAIN = "fact-literal";
export const MAX_FACT_LITERAL_LENGTH = 500;

export type FactObject = KnowledgeTarget | { literal: string };

export interface FactArgs {
    subject: KnowledgeTarget;
    relationKey: string;
    object: FactObject;
    /**
     * On a single-valued relation, the fact the person saw as current (or
     * null for none). A different current fact refuses the change (409,
     * `details.currentFactId`), so nobody replaces what they did not see.
     */
    expectedCurrentFactId?: string | null;
    /**
     * Replace whatever value is current instead: a finished review, whose
     * item showed the person this value to accept over the current one.
     */
    replaceCurrent?: boolean;
}

export interface Fact {
    id: string;
    scope: "personal" | "org";
    subject: KnowledgeTarget;
    relationKey: string;
    object: FactObject;
    origin: "recording" | "mail" | "manual";
    /** Supported evidence, and when the latest recording of it began. */
    supportedEvidence: number;
    lastSaidAt: Date | null;
}

function invalid(message: string, field: string): AppError {
    return new AppError(ErrorCode.INVALID_INPUT, message, 400, { field });
}

function factNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Fact not found", 404);
}

function cleanLiteral(literal: string): string {
    const clean = literal.normalize("NFC").trim().replace(/\s+/g, " ");
    if (!clean) throw invalid("The fact needs its text", "object");
    if (clean.length > MAX_FACT_LITERAL_LENGTH) {
        throw invalid("The text is too long", "object");
    }
    return clean;
}

/**
 * The relation a scope may state facts with: active, and core, the
 * Organization's, or the scope's own. A private type the Organization
 * adopted gives way to the Organization's, so the owner's later facts use
 * the shared one. Null when there is none.
 */
export async function findUsableRelationInTx(
    tx: Tx,
    scopeUserId: string,
    key: string,
) {
    const find = async (relationKey: string) => {
        const [row] = await tx
            .select({
                key: knowledgeRelationTypes.key,
                userId: knowledgeRelationTypes.userId,
                subjectTypes: knowledgeRelationTypes.subjectTypes,
                objectTypes: knowledgeRelationTypes.objectTypes,
                objectKind: knowledgeRelationTypes.objectKind,
                cardinality: knowledgeRelationTypes.cardinality,
                adoptedAsKey: knowledgeRelationTypes.adoptedAsKey,
            })
            .from(knowledgeRelationTypes)
            .where(
                and(
                    eq(knowledgeRelationTypes.key, relationKey),
                    eq(knowledgeRelationTypes.status, "active"),
                    or(
                        isNull(knowledgeRelationTypes.userId),
                        visibleOwnerCondition(
                            knowledgeRelationTypes.userId,
                            scopeUserId,
                        ),
                    ),
                ),
            )
            .limit(1);
        return row ?? null;
    };
    const relation = await find(key);
    if (relation?.userId === scopeUserId && relation.adoptedAsKey) {
        const adopted = await find(relation.adoptedAsKey);
        if (adopted) return adopted;
    }
    return relation;
}

async function usableRelation(tx: Tx, scopeUserId: string, key: string) {
    const relation = await findUsableRelationInTx(tx, scopeUserId, key);
    if (!relation) throw invalid("Unknown relation", "relationKey");
    return relation;
}

/** The key a fact's object is stored under: its node, or its words' hash. */
export function objectKeyOf(object: FactObject): string {
    return "literal" in object
        ? `l:${domainLookupHash(LITERAL_DOMAIN, cleanLiteral(object.literal))}`
        : nodeKey(object);
}

async function typeOf(tx: Tx, node: KnowledgeTarget): Promise<string> {
    if ("personId" in node) return "person";
    const [row] = await tx
        .select({ typeKey: knowledgeEntities.typeKey })
        .from(knowledgeEntities)
        .where(eq(knowledgeEntities.id, node.entityId))
        .limit(1);
    return row?.typeKey ?? "";
}

function subjectColumns(node: KnowledgeTarget) {
    return "personId" in node
        ? { subjectPersonId: node.personId, subjectEntityId: null }
        : { subjectPersonId: null, subjectEntityId: node.entityId };
}

function objectColumns(object: FactObject) {
    if ("literal" in object) {
        return {
            objectPersonId: null,
            objectEntityId: null,
            objectLiteral: encryptText(object.literal),
        };
    }
    return "personId" in object
        ? {
              objectPersonId: object.personId,
              objectEntityId: null,
              objectLiteral: null,
          }
        : {
              objectPersonId: null,
              objectEntityId: object.entityId,
              objectLiteral: null,
          };
}

/**
 * State a fact in `scopeUserId`'s scope, or find it stated already, and
 * return its id. The relation, the people and entities must all be the
 * scope's to use, and fit together (`relationFits`). Serialized per
 * (scope, subject, relation) by an advisory lock, so two confirmations of
 * one single-valued relation cannot both become current.
 *
 * On a single-valued relation the current fact must be the one the caller
 * expected; it is then replaced. Confirming a replaced fact again makes it
 * current once more. A `manual` confirmation makes a fact manual for good.
 */
export async function confirmFactInTx(
    tx: Tx,
    {
        scopeUserId,
        actorUserId,
        origin,
        ...args
    }: FactArgs & {
        scopeUserId: string;
        actorUserId: string;
        origin: "recording" | "mail" | "manual";
    },
): Promise<string> {
    const relation = await usableRelation(tx, scopeUserId, args.relationKey);
    const subject = await resolveTargetInTx(tx, scopeUserId, args.subject);
    const object: FactObject =
        "literal" in args.object
            ? { literal: cleanLiteral(args.object.literal) }
            : await resolveTargetInTx(tx, scopeUserId, args.object);
    const fits = relationFits(
        {
            subjectTypes: relation.subjectTypes,
            objectTypes: relation.objectTypes,
            objectKind: relation.objectKind as "entity" | "literal",
        },
        await typeOf(tx, subject),
        "literal" in object
            ? { literal: true }
            : { type: await typeOf(tx, object) },
    );
    if (!fits) throw invalid("The relation does not fit", "relationKey");

    const subjectKey = nodeKey(subject);
    const objectKey = objectKeyOf(object);
    await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`riffado:fact:${scopeUserId}|${subjectKey}|${relation.key}`}))`,
    );

    const sameKey = and(
        eq(knowledgeFacts.userId, scopeUserId),
        eq(knowledgeFacts.subjectKey, subjectKey),
        eq(knowledgeFacts.relationKey, relation.key),
    );
    const [existing] = await tx
        .select({
            id: knowledgeFacts.id,
            origin: knowledgeFacts.origin,
            replacedByFactId: knowledgeFacts.replacedByFactId,
        })
        .from(knowledgeFacts)
        .where(and(sameKey, eq(knowledgeFacts.objectKey, objectKey)))
        .limit(1);

    let current: { id: string } | undefined;
    if (relation.cardinality === "one") {
        [current] = await tx
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(and(sameKey, isNull(knowledgeFacts.replacedByFactId)))
            .orderBy(desc(knowledgeFacts.updatedAt), knowledgeFacts.id)
            .limit(1);
        const isCurrent = existing && current?.id === existing.id;
        if (!isCurrent && !args.replaceCurrent) {
            const expected = args.expectedCurrentFactId ?? null;
            if ((current?.id ?? null) !== expected) {
                throw new AppError(
                    ErrorCode.CONFLICT,
                    "The fact changed; reload",
                    409,
                    { currentFactId: current?.id ?? null },
                );
            }
        }
    }

    let factId: string;
    if (existing) {
        factId = existing.id;
        const becomesManual =
            origin === "manual" && existing.origin !== "manual";
        if (existing.replacedByFactId || becomesManual) {
            await tx
                .update(knowledgeFacts)
                .set({
                    replacedByFactId: null,
                    ...(becomesManual ? { origin } : {}),
                    updatedAt: new Date(),
                })
                .where(eq(knowledgeFacts.id, factId));
        }
    } else {
        const [created] = await tx
            .insert(knowledgeFacts)
            .values({
                userId: scopeUserId,
                ...subjectColumns(subject),
                relationKey: relation.key,
                ...objectColumns(object),
                subjectKey,
                objectKey,
                origin,
                createdByUserId: actorUserId,
            })
            .returning({ id: knowledgeFacts.id });
        factId = (created as { id: string }).id;
    }
    if (current && current.id !== factId) {
        await tx
            .update(knowledgeFacts)
            .set({ replacedByFactId: factId, updatedAt: new Date() })
            .where(eq(knowledgeFacts.id, current.id));
    }
    return factId;
}

export interface RecordingFactArgs extends FactArgs {
    /** The transcript's owner, whose transcript it is. */
    ownerUserId: string;
    transcriptionId: string;
    /** The transcript revision the person was looking at. */
    revision: number;
    actorUserId: string;
    /** `sharingOrgUserId()`, resolved before the transaction. */
    orgUserId: string | null;
    startMs: number;
    endMs: number;
    /**
     * The label whose speaker the fact is about, when it is ("I lead
     * Orion"): its confirmed person must be the fact's subject or object,
     * and renaming that speaker puts the evidence to review.
     */
    speakerLabel?: string | null;
}

/**
 * Confirm a fact from what was said in a recording, with its evidence:
 * the words spoken over `startMs`..`endMs`, cut from the transcript here
 * rather than taken from the caller. Under the recording lock and the
 * writer rule, on the revision the person saw; the fact goes into the
 * actor's scope (the owner's on a private recording, the Organization's on
 * a shared one). Returns the fact's id.
 */
export async function confirmFactFromRecording(
    args: RecordingFactArgs,
): Promise<string> {
    return db.transaction(async (tx) => {
        await lockOrgPeopleShared(tx);
        const factId = await confirmFactFromRecordingInTx(tx, args);
        await bumpScopeInTx(tx, [args.actorUserId]);
        return factId;
    });
}

/**
 * `confirmFactFromRecording` inside a caller's transaction, which took the
 * Organization-people lock (shared) first and bumps the actor's scope
 * once, last, with everything else it changed (a finished review).
 */
export async function confirmFactFromRecordingInTx(
    tx: Tx,
    args: RecordingFactArgs,
): Promise<string> {
    if (args.startMs < 0 || args.endMs < args.startMs) {
        throw invalid("The time range is not valid", "startMs");
    }
    const { recordingId, revision, turns } = await lockTranscriptForChange(
        tx,
        { userId: args.ownerUserId, transcriptionId: args.transcriptionId },
        args,
    );
    if (revision !== args.revision) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "The transcript changed; reload",
            409,
        );
    }
    const quote = quoteFromTurns(turns, args.startMs, args.endMs);
    if (!quote) throw invalid("Nothing was said then", "startMs");
    const speakerLabel = args.speakerLabel ?? null;
    if (speakerLabel) {
        if (
            !speakerLabelsForTranscript({ text: "", turns }).includes(
                speakerLabel,
            )
        ) {
            throw invalid("No such speaker", "speakerLabel");
        }
        await assertSpeakerInFact(tx, args, speakerLabel);
    }
    const factId = await confirmFactInTx(tx, {
        ...args,
        scopeUserId: args.actorUserId,
        origin: "recording",
    });
    await tx
        .insert(knowledgeFactEvidence)
        .values({
            userId: args.actorUserId,
            factId,
            transcriptionId: args.transcriptionId,
            itemId: recordingId,
            transcriptRevision: revision,
            startMs: args.startMs,
            endMs: args.endMs,
            speakerLabel,
            dependsOnSpeaker: speakerLabel !== null,
            quote: encryptText(quote),
            confirmedByUserId: args.actorUserId,
        })
        // The same words confirmed again: whatever review they were
        // under, a person has just said they support the fact.
        .onConflictDoUpdate({
            target: [
                knowledgeFactEvidence.factId,
                knowledgeFactEvidence.transcriptionId,
                knowledgeFactEvidence.startMs,
                knowledgeFactEvidence.endMs,
            ],
            set: {
                status: "supported",
                transcriptRevision: revision,
                speakerLabel,
                dependsOnSpeaker: speakerLabel !== null,
                quote: encryptText(quote),
                confirmedByUserId: args.actorUserId,
                confirmedAt: new Date(),
            },
        });
    return factId;
}

export interface MailFactArgs extends FactArgs {
    /** The mail's owner, whose content it is. */
    ownerUserId: string;
    itemId: string;
    /** The content revision the person was looking at. */
    revision: number;
    actorUserId: string;
    /** Where in the mail's content it was written. */
    text: { segmentIndex: number; charStart: number; charEnd: number };
    /** The participant who wrote it, when the fact is about them. */
    speakerLabel?: string | null;
}

/**
 * Confirm a fact from what a mail says, with its evidence: the words of
 * one segment's range, cut from the mail's content here. The caller holds
 * the mail's lock and checked the writer rule; the content must still be
 * the revision the person saw. The fact goes into the actor's scope.
 * Returns the fact's id.
 */
export async function confirmFactFromMailInTx(
    tx: Tx,
    args: MailFactArgs,
): Promise<string> {
    const [content] = await tx
        .select({
            revision: mailContents.revision,
            segments: mailContents.segments,
        })
        .from(mailContents)
        .where(
            and(
                eq(mailContents.itemId, args.itemId),
                eq(mailContents.userId, args.ownerUserId),
            ),
        )
        .limit(1);
    if (!content || content.revision !== args.revision) {
        throw new AppError(ErrorCode.CONFLICT, "The mail changed; reload", 409);
    }
    const segment = (
        decryptJsonField<ContentSegment[]>(content.segments) ?? []
    ).find((candidate) => candidate.index === args.text.segmentIndex);
    const quote = segment?.text
        .slice(args.text.charStart, args.text.charEnd)
        .trim();
    if (!quote) throw invalid("Nothing was written there", "text");
    const factId = await confirmFactInTx(tx, {
        ...args,
        scopeUserId: args.actorUserId,
        origin: "mail",
    });
    await tx
        .insert(knowledgeFactEvidence)
        .values({
            userId: args.actorUserId,
            factId,
            transcriptionId: null,
            itemId: args.itemId,
            transcriptRevision: args.revision,
            startMs: null,
            endMs: null,
            segmentIndex: args.text.segmentIndex,
            charStart: args.text.charStart,
            charEnd: args.text.charEnd,
            speakerLabel: args.speakerLabel ?? null,
            dependsOnSpeaker: false,
            quote: encryptText(quote),
            confirmedByUserId: args.actorUserId,
        })
        .onConflictDoUpdate({
            target: [
                knowledgeFactEvidence.factId,
                knowledgeFactEvidence.itemId,
                knowledgeFactEvidence.segmentIndex,
                knowledgeFactEvidence.charStart,
                knowledgeFactEvidence.charEnd,
            ],
            targetWhere: sql`${knowledgeFactEvidence.segmentIndex} is not null`,
            set: {
                status: "supported",
                transcriptRevision: args.revision,
                speakerLabel: args.speakerLabel ?? null,
                quote: encryptText(quote),
                confirmedByUserId: args.actorUserId,
                confirmedAt: new Date(),
            },
        });
    return factId;
}

/**
 * A fact that depends on a speaker is about the person confirmed for that
 * label, so deleting or renaming them reaches it. 400 otherwise.
 */
async function assertSpeakerInFact(
    tx: Tx,
    args: RecordingFactArgs,
    speakerLabel: string,
): Promise<void> {
    const [speaker] = await tx
        .select({ personId: transcriptSpeakers.personId })
        .from(transcriptSpeakers)
        .where(
            and(
                eq(transcriptSpeakers.transcriptionId, args.transcriptionId),
                eq(transcriptSpeakers.label, speakerLabel),
                eq(transcriptSpeakers.status, "confirmed"),
            ),
        )
        .limit(1);
    const named = speaker?.personId;
    const people = await Promise.all(
        [args.subject, args.object].map(async (node) =>
            "personId" in node
                ? await resolveTargetInTx(tx, args.actorUserId, node)
                : null,
        ),
    );
    const inFact = people.some(
        (node) => node && "personId" in node && node.personId === named,
    );
    if (!named || !inFact) {
        throw invalid(
            "The speaker is not confirmed as a person in the fact",
            "speakerLabel",
        );
    }
}

/**
 * Refuse a fact typed by hand about a person whose text names a denied
 * topic (health, family, personality, performance, demographics), as a
 * type's name is refused: the same word list, no model. What a term means
 * is not about anyone ("Key Performance Indicator"), so only facts about
 * people are screened.
 */
function assertTextAllowed(subject: KnowledgeTarget, object: FactObject): void {
    if (!("personId" in subject) || !("literal" in object)) return;
    const denied = deniedTopicOf(object.literal);
    if (denied) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Knowledge about people's health, family, personality, performance or demographics is not kept",
            400,
            { field: "object", deniedTopic: denied.id },
        );
    }
}

/**
 * State a fact by hand, in the actor's own scope: the organization
 * account's are the Organization's. It needs no evidence and never decays.
 */
export async function confirmManualFact(
    actorUserId: string,
    args: FactArgs,
): Promise<string> {
    assertTextAllowed(args.subject, args.object);
    return db.transaction(async (tx) => {
        await lockOrgPeopleShared(tx);
        const factId = await confirmFactInTx(tx, {
            ...args,
            scopeUserId: actorUserId,
            actorUserId,
            origin: "manual",
        });
        await bumpScopeInTx(tx, [actorUserId]);
        return factId;
    });
}

/**
 * Take back one piece of evidence the actor's scope holds on a transcript
 * (the review's "drop"), under the recording lock and the writer rule. A
 * fact from recordings left with none goes. 404 alike for a missing piece
 * and another scope's.
 */
export async function withdrawEvidence(args: {
    ownerUserId: string;
    transcriptionId: string;
    evidenceId: string;
    actorUserId: string;
    orgUserId: string | null;
}): Promise<void> {
    await db.transaction(async (tx) => {
        await lockTranscriptForChange(
            tx,
            { userId: args.ownerUserId, transcriptionId: args.transcriptionId },
            args,
        );
        const [removed] = await tx
            .delete(knowledgeFactEvidence)
            .where(
                and(
                    eq(knowledgeFactEvidence.id, args.evidenceId),
                    eq(knowledgeFactEvidence.userId, args.actorUserId),
                    eq(
                        knowledgeFactEvidence.transcriptionId,
                        args.transcriptionId,
                    ),
                ),
            )
            .returning({ factId: knowledgeFactEvidence.factId });
        if (!removed) {
            throw new AppError(ErrorCode.NOT_FOUND, "Evidence not found", 404);
        }
        await pruneUnsupportedFactsInTx(tx, [removed.factId]);
        await bumpScopeInTx(tx, [args.actorUserId]);
    });
}

/**
 * Delete a fact of the actor's own scope, evidence and all. 404 alike for
 * a missing fact and another scope's.
 */
export async function deleteFact(
    actorUserId: string,
    factId: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        // Exclusive, as every deletion: it changes the chain around the
        // fact, which merges, other deletions and confirmations (shared)
        // change too, each in its own order.
        await lockOrgPeople(tx);
        const ownFact = and(
            eq(knowledgeFacts.id, factId),
            eq(knowledgeFacts.userId, actorUserId),
        );
        const [mine] = await tx
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(ownFact);
        if (!mine) throw factNotFound();
        // The rewrite's lock next, as it takes it before the facts.
        await lockRecordingsNaming(tx, { factIds: [factId] });
        const [own] = await tx
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(ownFact)
            .for("update");
        if (!own) throw factNotFound();
        await deleteFactsInTx(tx, [factId]);
        await bumpScopeInTx(tx, [actorUserId]);
    });
}

/**
 * Change what a fact of the actor's own scope says: a manual fact with
 * `object` takes its place and it is erased, in one transaction. On a
 * single-valued relation it must still be the current value (409 with
 * `details.currentFactId` otherwise). Returns the fact now stating it.
 */
export async function replaceFact(
    actorUserId: string,
    factId: string,
    object: FactObject,
): Promise<string> {
    return db.transaction(async (tx) => {
        // Exclusive, as deleteFact: the old fact goes.
        await lockOrgPeople(tx);
        const ownFact = and(
            eq(knowledgeFacts.id, factId),
            eq(knowledgeFacts.userId, actorUserId),
        );
        const [mine] = await tx
            .select({ id: knowledgeFacts.id })
            .from(knowledgeFacts)
            .where(ownFact);
        if (!mine) throw factNotFound();
        await lockRecordingsNaming(tx, { factIds: [factId] });
        const [old] = await tx
            .select({
                subjectPersonId: knowledgeFacts.subjectPersonId,
                subjectEntityId: knowledgeFacts.subjectEntityId,
                relationKey: knowledgeFacts.relationKey,
            })
            .from(knowledgeFacts)
            .where(ownFact)
            .for("update");
        if (!old) throw factNotFound();
        const subject = nodeOf(old.subjectPersonId, old.subjectEntityId);
        assertTextAllowed(subject, object);
        const replacement = await confirmFactInTx(tx, {
            scopeUserId: actorUserId,
            actorUserId,
            origin: "manual",
            subject,
            relationKey: old.relationKey,
            object,
            expectedCurrentFactId: factId,
        });
        if (replacement !== factId) await deleteFactsInTx(tx, [factId]);
        await bumpScopeInTx(tx, [actorUserId]);
        return replacement;
    });
}

function nodeOf(
    personId: string | null,
    entityId: string | null,
): KnowledgeTarget {
    return personId ? { personId } : { entityId: entityId ?? "" };
}

/**
 * The current facts about a person or an entity that `viewerUserId` may
 * see: their own scope's and the Organization's. A fact from recordings
 * shows while some of its evidence is supported on a recording the viewer
 * can open (their own, or a shared one); "last said" is when the latest of
 * those began.
 */
export async function listFacts(
    viewerUserId: string,
    target: KnowledgeTarget,
): Promise<Fact[]> {
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
    const rows = await db
        .select({
            id: knowledgeFacts.id,
            ownerRole: users.role,
            subjectPersonId: knowledgeFacts.subjectPersonId,
            subjectEntityId: knowledgeFacts.subjectEntityId,
            relationKey: knowledgeFacts.relationKey,
            objectPersonId: knowledgeFacts.objectPersonId,
            objectEntityId: knowledgeFacts.objectEntityId,
            objectLiteral: knowledgeFacts.objectLiteral,
            origin: knowledgeFacts.origin,
            updatedAt: knowledgeFacts.updatedAt,
        })
        .from(knowledgeFacts)
        .innerJoin(users, eq(users.id, knowledgeFacts.userId))
        .where(
            and(
                about,
                isNull(knowledgeFacts.replacedByFactId),
                visibleOwnerCondition(knowledgeFacts.userId, viewerUserId),
            ),
        )
        .orderBy(desc(knowledgeFacts.updatedAt));
    if (rows.length === 0) return [];

    const support = await db
        .select({
            factId: knowledgeFactEvidence.factId,
            count: sql<number>`count(*)::int`,
            lastSaidAt: sql<Date | null>`max(${chatterItems.occurredAt})`,
        })
        .from(knowledgeFactEvidence)
        .innerJoin(recordings, eq(recordings.id, knowledgeFactEvidence.itemId))
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                inArray(
                    knowledgeFactEvidence.factId,
                    rows.map((row) => row.id),
                ),
                eq(knowledgeFactEvidence.status, "supported"),
                // On recordings the viewer can open: their own, or shared.
                isNull(recordings.deletedAt),
                or(
                    eq(recordings.userId, viewerUserId),
                    recordingSharedCondition(recordings.id),
                ),
            ),
        )
        .groupBy(knowledgeFactEvidence.factId);
    const byFact = new Map(support.map((row) => [row.factId, row]));

    return rows.flatMap((row) => {
        const evidence = byFact.get(row.id);
        if (row.origin === "recording" && !evidence) return [];
        const lastSaidAt = evidence?.lastSaidAt ?? null;
        return [
            {
                id: row.id,
                scope: row.ownerRole === "org" ? "org" : "personal",
                subject: nodeOf(row.subjectPersonId, row.subjectEntityId),
                relationKey: row.relationKey,
                object: row.objectLiteral
                    ? { literal: decryptText(row.objectLiteral) }
                    : nodeOf(row.objectPersonId, row.objectEntityId),
                origin: row.origin,
                supportedEvidence: evidence?.count ?? 0,
                lastSaidAt: lastSaidAt ? new Date(lastSaidAt) : null,
            } satisfies Fact,
        ];
    });
}
