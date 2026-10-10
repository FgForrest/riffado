/**
 * Reviewing a Learn run (Task 4.2): reading what it proposed, deciding item
 * by item (drafts kept on the server, versioned), and finishing the review
 * in one transaction that applies what was ticked and remembers what was
 * not, so the next run does not propose it again.
 *
 * Whoever may change the recording in the run's view reviews it: the owner
 * on the private view, the organization account on the Organization view
 * of a shared recording. Unconfirmed suggestions are theirs alone to see.
 *
 * Finishing re-checks everything under the locks the executors take:
 * the run is still ready, the transcript still the revision it read, the
 * actor still its writer, and every item still at the version the person
 * saw. Each ticked item is applied in a savepoint, so one that no longer
 * holds (its target deleted, its words corrected meanwhile) is skipped and
 * reported, not the whole review lost.
 *
 * New people and things go first: each ticked one is added to the run's
 * scope (or found there, when another review added it meanwhile, or taken
 * as the record the reviewer said it is), and what refers to it by its ref
 * is applied to that record. What refers to one left unticked is skipped.
 */

import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    knowledgeEntities,
    knowledgeFacts,
    learnDismissals,
    learnReviewItems,
    learnRuns,
    mailContents,
    mailParticipants,
    people,
    personEmails,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import {
    decryptJsonField,
    decryptText,
    encryptJsonField,
    encryptText,
} from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { nudge } from "@/lib/jobs/nudge";
import {
    addAliasInTx,
    type KnowledgeTarget,
    resolveTargetInTx,
} from "@/lib/knowledge/aliases";
import { wordsAt } from "@/lib/knowledge/correction-anchors";
import { acceptCorrectionInTx } from "@/lib/knowledge/corrections";
import {
    createEntityInTx,
    findEntityByNameInTx,
} from "@/lib/knowledge/entities";
import {
    confirmFactFromMailInTx,
    confirmFactFromRecordingInTx,
} from "@/lib/knowledge/facts";
import { knowledgeView } from "@/lib/knowledge/knowledge-loader";
import { domainLookupHash, lookupHash } from "@/lib/knowledge/lookup-hash";
import { matchNames } from "@/lib/knowledge/name-match";
import { lockOrgPeopleShared } from "@/lib/knowledge/org-people";
import { createPersonInTx } from "@/lib/knowledge/people";
import { readableScopes } from "@/lib/knowledge/scope";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import {
    answerSpeakerInTx,
    type SpeakerAnswer,
} from "@/lib/knowledge/speaker-changes";
import { stemmingLanguage, stemVariants } from "@/lib/knowledge/stemming";
import { lockTranscriptForChange } from "@/lib/knowledge/transcript-lock";
import {
    bumpVocabularyVersionInTx,
    createOwnTypeInTx,
    type NewTypeSpec,
    proposePhraseInTx,
    vocabularyVisibleTo,
} from "@/lib/knowledge/vocabulary";
import { releaseAutoLearnHold } from "@/lib/learn/auto-learn";
import { queueCorrectionPassInTx } from "@/lib/learn/correction-pass-queue";
import { settleDeadLearnRuns } from "@/lib/learn/learn-job";
import type {
    MailNewRecordPayload,
    MailReviewCandidate,
    MailTextAnchor,
} from "@/lib/learn/mail-candidates";
import {
    type RecordTarget,
    recordNameKey,
    replaceRefs,
} from "@/lib/learn/new-refs";
import type { LearnObject, LearnSubject } from "@/lib/learn/output";
import type { ReviewCandidate } from "@/lib/learn/validate";
import type { NewRecordPayload } from "@/lib/learn/validate-new-records";
import { assertOwnScopeWritable, getOrgUserId } from "@/lib/org/config";
import type { RecordingViewContext } from "@/lib/sharing/access";
import {
    contentWriterRefusal,
    sharingOrgUserId,
    writerRefusalError,
} from "@/lib/sharing/writer";
import type { TranscriptTurn } from "@/lib/transcription/turns";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ItemKind = ReviewCandidate["kind"];

/** What a person chose along with a decision, where the kind needs one. */
export type ReviewChoice =
    | { personId: string }
    | { entityId: string }
    | { displayName: string }
    /** A new record under another name, or of another type. */
    | { name: string; typeKey: string | null }
    | { unknown: true }
    | { action: "create"; spec: Extract<NewTypeSpec, { kind: "relation" }> }
    | { action: "suggest" };

export interface ReviewItemView {
    id: string;
    kind: ItemKind;
    preTicked: boolean;
    decision: "accepted" | "rejected" | null;
    choice: ReviewChoice | null;
    version: number;
    dependsOnLabel: string | null;
    /** Once the review is finished: what became of it. */
    outcome: ItemOutcome | null;
    payload: ReviewCandidate["payload"];
}

export interface ReviewView {
    run: {
        id: string;
        status: string;
        /** The transcript a run on a recording read; null on other kinds. */
        transcriptionId: string | null;
        createdAt: string;
        finishedAt: string | null;
        /** Why a failed run failed (`ErrorCode`). */
        errorCode: string | null;
    } | null;
    /** A ready run's items to decide, or a finished run's with outcomes. */
    items: ReviewItemView[];
    /**
     * A finished run that found nothing: how many people and things it
     * could match what it heard against.
     */
    known?: { people: number; things: number };
    /** Names of the people and entities the items refer to, by id. */
    names: Record<string, string>;
    /** Their types (`person` for people), for "create as my relation". */
    types: Record<string, string>;
    /** Labels of the relations the items use, by key. */
    relations: Record<string, string>;
    /** The types a new thing may take, for a new record's type. */
    entityTypes?: { key: string; label: string }[];
}

/** A unique index refused a row another transaction wrote meanwhile. */
function isUniqueViolation(error: unknown): boolean {
    const value = error as { code?: unknown; cause?: { code?: unknown } };
    return value?.code === "23505" || value?.cause?.code === "23505";
}

/**
 * The speaker a fact depends on: the one it is about, else the one who
 * said it; null when neither.
 */
function speakerOf(payload: {
    subject: LearnSubject;
    speakerLabel: string | null;
}): string | null {
    return "speakerLabel" in payload.subject
        ? payload.subject.speakerLabel
        : payload.speakerLabel;
}

function reviewNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Nothing to review", 404);
}

/** Which of a recording's transcripts a review is about. */
export type ReviewSource = "plaud" | "riffado";

/** `?source=` of a review request; absent means any transcript. */
export function requestedReviewSource(
    request: Request,
): ReviewSource | undefined {
    const source = new URL(request.url).searchParams.get("source");
    return source === "plaud" || source === "riffado" ? source : undefined;
}

/**
 * The run a review is about: the latest in the recording's view, on the
 * transcript of `source` when one is given (each transcript has its own).
 */
async function latestRun(access: RecordingViewContext, source?: ReviewSource) {
    if (access.kind === "mail") {
        const [run] = await db
            .select()
            .from(learnRuns)
            .where(
                and(
                    eq(learnRuns.itemId, access.recordingId),
                    eq(learnRuns.view, access.view),
                    isNull(learnRuns.transcriptionId),
                ),
            )
            .orderBy(desc(learnRuns.createdAt))
            .limit(1);
        return run ?? null;
    }
    const [row] = await db
        .select({ run: learnRuns })
        .from(learnRuns)
        .innerJoin(
            transcriptions,
            eq(transcriptions.id, learnRuns.transcriptionId),
        )
        .where(
            and(
                eq(learnRuns.itemId, access.recordingId),
                eq(learnRuns.view, access.view),
                source ? eq(transcriptions.source, source) : undefined,
            ),
        )
        .orderBy(desc(learnRuns.createdAt))
        .limit(1);
    return row?.run ?? null;
}

function idsIn(value: unknown, into: Set<string>): void {
    if (Array.isArray(value)) {
        for (const item of value) idsIn(item, into);
        return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
        if (
            (key === "personId" || key === "entityId") &&
            typeof inner === "string"
        ) {
            into.add(inner);
        } else {
            idsIn(inner, into);
        }
    }
}

/**
 * The latest run in the view and what it proposed: open for deciding when
 * it is ready, with what became of each item once it is finished. A run
 * that found nothing says how much it had to go on.
 */
export async function loadReview(
    access: RecordingViewContext,
    source?: ReviewSource,
): Promise<ReviewView> {
    // A run whose job died reads as failed, not as learning forever.
    await settleDeadLearnRuns(access.recordingId);
    const run = await latestRun(access, source);
    if (!run) {
        return { run: null, items: [], names: {}, types: {}, relations: {} };
    }
    const summary = {
        id: run.id,
        status: run.status,
        transcriptionId: run.transcriptionId,
        createdAt: run.createdAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        errorCode: run.errorCode,
    };
    if (run.status !== "ready" && run.status !== "finished") {
        return { run: summary, items: [], names: {}, types: {}, relations: {} };
    }
    const rows = await db
        .select()
        .from(learnReviewItems)
        .where(eq(learnReviewItems.runId, run.id))
        .orderBy(learnReviewItems.createdAt, learnReviewItems.id);
    const items: ReviewItemView[] = rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        preTicked: row.preTicked,
        decision: row.decision ?? null,
        choice: row.choice ? decryptJsonField<ReviewChoice>(row.choice) : null,
        version: row.version,
        dependsOnLabel: row.dependsOnLabel,
        outcome: (row.outcome as ItemOutcome | null) ?? null,
        payload: decryptJsonField<ReviewCandidate["payload"]>(
            row.payload,
        ) as ReviewCandidate["payload"],
    }));
    if (items.length === 0) {
        return {
            run: summary,
            items,
            names: {},
            types: {},
            relations: {},
            known: await knownCounts(run),
        };
    }
    const view = await knowledgeView({
        kind: "recording",
        ownerUserId: run.userId,
        shared: run.view === "org",
    });
    const referenced = new Set<string>();
    for (const item of items) idsIn([item.payload, item.choice], referenced);
    const names: Record<string, string> = {};
    const types: Record<string, string> = {};
    for (const item of view.items) {
        if (!referenced.has(item.id)) continue;
        names[item.id] = item.name;
        types[item.id] = item.kind === "person" ? "person" : item.typeKey;
    }
    const vocabulary = await vocabularyVisibleTo(run.scopeUserId, {
        sharedOnly: run.view === "org",
    });
    const relations: Record<string, string> = {};
    for (const relation of vocabulary.relationTypes) {
        relations[relation.key] = relation.label;
    }
    const entityTypes = vocabulary.entityTypes
        .filter((type) => type.key !== "person" && !type.adoptedAsKey)
        .map((type) => ({ key: type.key, label: type.label }));
    return { run: summary, items, names, types, relations, entityTypes };
}

/**
 * How many people and things a run could match against: counted, not
 * loaded, since an empty run is shown on every visit to its recording.
 */
async function knownCounts(run: {
    userId: string;
    view: "private" | "org";
}): Promise<{ people: number; things: number }> {
    const scopes = readableScopes(
        {
            kind: "recording",
            ownerUserId: run.userId,
            shared: run.view === "org",
        },
        await getOrgUserId(),
    );
    const [[person], [thing]] = await Promise.all([
        db
            .select({ n: count() })
            .from(people)
            .where(
                and(
                    inArray(people.userId, scopes),
                    isNull(people.mergedIntoId),
                ),
            ),
        db
            .select({ n: count() })
            .from(knowledgeEntities)
            .where(
                and(
                    inArray(knowledgeEntities.userId, scopes),
                    isNull(knowledgeEntities.mergedIntoId),
                ),
            ),
    ]);
    return { people: person?.n ?? 0, things: thing?.n ?? 0 };
}

/**
 * Forget what was rejected on the recording in this view, so the next run
 * may propose it again. Returns how many rejections were forgotten.
 */
export async function forgetDismissals(
    access: RecordingViewContext,
): Promise<number> {
    const scopeUserId =
        access.view === "org" && access.orgUserId
            ? access.orgUserId
            : access.ownerUserId;
    const forgotten = await db
        .delete(learnDismissals)
        .where(
            and(
                eq(learnDismissals.userId, scopeUserId),
                eq(learnDismissals.itemId, access.recordingId),
            ),
        )
        .returning({ id: learnDismissals.id });
    return forgotten.length;
}

const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 200;
const MAX_TYPES = 20;

function recordMissing(): AppError {
    return new AppError(
        ErrorCode.INVALID_INPUT,
        "A record it needs was not added",
        400,
    );
}

/** Live people of these scopes by their name as compared (`recordNameKey`). */
async function peopleNamedInTx(
    tx: Tx,
    scopes: readonly string[],
): Promise<Map<string, string[]>> {
    const rows = await tx
        .select({ id: people.id, name: people.displayName })
        .from(people)
        .where(
            and(
                inArray(people.userId, [...scopes]),
                isNull(people.mergedIntoId),
            ),
        );
    const named = new Map<string, string[]>();
    for (const row of rows) {
        const key = recordNameKey(decryptText(row.name));
        named.set(key, [...(named.get(key) ?? []), row.id]);
    }
    return named;
}

/**
 * The record a new one turns out to be: a thing of that name and type in
 * a scope the run reads (its own first), or the one person of that name.
 */
async function existingRecordInTx(
    tx: Tx,
    record: { kind: "person" | "entity"; typeKey: string | null; name: string },
    scopes: readonly string[],
    peopleByName: ReadonlyMap<string, string[]>,
): Promise<RecordTarget | null> {
    if (record.kind === "person") {
        const ids = peopleByName.get(recordNameKey(record.name)) ?? [];
        return ids.length === 1 && ids[0] ? { personId: ids[0] } : null;
    }
    if (!record.typeKey) return null;
    for (const scope of [...scopes].reverse()) {
        const id = await findEntityByNameInTx(
            tx,
            scope,
            record.typeKey,
            record.name,
        );
        if (id) return { entityId: id };
    }
    return null;
}

/** A live record's name, when it is in one of these scopes; else null. */
async function readableRecordNameInTx(
    tx: Tx,
    target: RecordTarget,
    scopes: readonly string[],
): Promise<string | null> {
    const [row] =
        "personId" in target
            ? await tx
                  .select({ name: people.displayName })
                  .from(people)
                  .where(
                      and(
                          eq(people.id, target.personId),
                          inArray(people.userId, [...scopes]),
                          isNull(people.mergedIntoId),
                      ),
                  )
            : await tx
                  .select({ name: knowledgeEntities.name })
                  .from(knowledgeEntities)
                  .where(
                      and(
                          eq(knowledgeEntities.id, target.entityId),
                          inArray(knowledgeEntities.userId, [...scopes]),
                          isNull(knowledgeEntities.mergedIntoId),
                      ),
                  );
    return row ? decryptText(row.name) : null;
}

/**
 * Whether a name Learn heard is worth keeping as the record's nickname:
 * only one the lookups would not find it by anyway. "Honza" for Jan
 * Novotný is; "Milan" for Milan Petrák is not (it would make every Milan
 * him), nor "MCP server" for MCP (every "server" would be MCP), nor a
 * misspelling or a word form ("Velltrix", "Šimákem").
 */
function nicknameWorthKeeping(
    heard: string,
    name: string,
    language: string | null,
): boolean {
    const key = stemmingLanguage(language);
    return (
        matchNames(
            heard,
            [{ id: "record", names: [name] }],
            key ? { key, stem: (word) => stemVariants(word, key) } : undefined,
        ).length === 0
    );
}

/** A string with something in it, and not too much. */
function short(value: unknown, max: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validChoice(
    kind: ItemKind,
    choice: unknown,
    /** A new record's kind: what it may be named, typed or taken as. */
    recordKind?: "person" | "entity",
): ReviewChoice | null {
    if (choice === null || choice === undefined) return null;
    if (typeof choice !== "object") return invalidChoice();
    const value = choice as Record<string, unknown>;
    if (kind === "speaker") {
        if (value.unknown === true) return { unknown: true };
        if (short(value.personId, MAX_ID_LENGTH)) {
            return { personId: value.personId };
        }
        // Someone new, created and named when the review is finished.
        if (typeof value.displayName === "string") {
            const displayName = value.displayName.trim();
            if (short(displayName, MAX_NAME_LENGTH)) return { displayName };
        }
        return invalidChoice();
    }
    if (kind === "new_record") {
        // The record the Almanac has that it is: a person for a person,
        // a thing for a thing.
        if (recordKind === "person" && short(value.personId, MAX_ID_LENGTH)) {
            return { personId: value.personId };
        }
        if (recordKind === "entity" && short(value.entityId, MAX_ID_LENGTH)) {
            return { entityId: value.entityId };
        }
        // Another name; a thing's type, a person none.
        const name = typeof value.name === "string" ? value.name.trim() : "";
        if (
            short(name, MAX_NAME_LENGTH) &&
            (recordKind === "person"
                ? value.typeKey === null
                : recordKind === "entity" &&
                  short(value.typeKey, MAX_ID_LENGTH))
        ) {
            return { name, typeKey: value.typeKey as string | null };
        }
        return invalidChoice();
    }
    if (kind === "relation_phrase") {
        if (value.action === "suggest") return { action: "suggest" };
        const spec = value.spec as Record<string, unknown> | undefined;
        const types = (list: unknown): list is string[] =>
            Array.isArray(list) &&
            list.length <= MAX_TYPES &&
            list.every((type) => short(type, MAX_ID_LENGTH));
        if (
            value.action === "create" &&
            spec &&
            typeof spec.label === "string" &&
            short(spec.label.trim(), MAX_NAME_LENGTH) &&
            types(spec.subjectTypes) &&
            types(spec.objectTypes) &&
            (spec.objectKind === "entity" || spec.objectKind === "literal") &&
            (spec.cardinality === "one" || spec.cardinality === "many")
        ) {
            return {
                action: "create",
                spec: {
                    kind: "relation",
                    label: spec.label.trim(),
                    subjectTypes: spec.subjectTypes,
                    objectTypes: spec.objectTypes,
                    objectKind: spec.objectKind,
                    cardinality: spec.cardinality,
                },
            };
        }
        return invalidChoice();
    }
    return invalidChoice();
}

function invalidChoice(): never {
    throw new AppError(
        ErrorCode.INVALID_INPUT,
        "That choice does not fit this item",
        400,
        { field: "choice" },
    );
}

/**
 * Keep a draft decision on one item of the ready run, if the person saw its
 * latest version (409 otherwise). `decision: null` goes back to the
 * default. Returns the item's new version.
 */
export async function decideReviewItem(
    access: RecordingViewContext,
    itemId: string,
    input: {
        decision: "accepted" | "rejected" | null;
        version: number;
        choice?: unknown;
    },
    source?: ReviewSource,
): Promise<{ version: number }> {
    const latest = await latestRun(access, source);
    if (!latest || latest.status !== "ready") throw reviewNotFound();
    // Under the run held for share: a finish holds it for update, so a
    // draft either lands before it (and is applied) or finds it finished.
    return db.transaction(async (tx) => {
        const [run] = await tx
            .select({ status: learnRuns.status })
            .from(learnRuns)
            .where(eq(learnRuns.id, latest.id))
            .for("share");
        if (run?.status !== "ready") throw reviewNotFound();
        return keepDraft(tx, latest.id, itemId, input);
    });
}

async function keepDraft(
    tx: Tx,
    runId: string,
    itemId: string,
    input: {
        decision: "accepted" | "rejected" | null;
        version: number;
        choice?: unknown;
    },
): Promise<{ version: number }> {
    const [item] = await tx
        .select({
            kind: learnReviewItems.kind,
            payload: learnReviewItems.payload,
        })
        .from(learnReviewItems)
        .where(
            and(
                eq(learnReviewItems.id, itemId),
                eq(learnReviewItems.runId, runId),
            ),
        );
    if (!item) throw reviewNotFound();
    const choice = validChoice(
        item.kind,
        input.choice,
        item.kind === "new_record"
            ? decryptJsonField<NewRecordPayload>(item.payload)?.kind
            : undefined,
    );
    const [updated] = await tx
        .update(learnReviewItems)
        .set({
            decision: input.decision,
            choice: choice ? encryptJsonField(choice) : null,
            version: input.version + 1,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(learnReviewItems.id, itemId),
                eq(learnReviewItems.version, input.version),
            ),
        )
        .returning({ version: learnReviewItems.version });
    if (!updated) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "This item changed; reload the review",
            409,
        );
    }
    return updated;
}

/** Why an item ticked was not applied, for the reader's words. */
export type SkipCode =
    | "nobody_chosen"
    | "answered_since"
    | "speaker_not_named"
    | "known_elsewhere"
    | "nothing_chosen"
    | "already_exists"
    | "changed"
    | "no_longer_fits"
    /** It refers to a new record that was not added. */
    | "record_not_added";

/** What finishing a review did with an item. */
export type ItemOutcome = "applied" | "rejected" | SkipCode;

export interface FinishedReview {
    status: "finished" | "superseded";
    /** Items applied. */
    applied: number;
    dismissed: number;
    /** Ticked items not applied: a code, and the server's words (logs). */
    skipped: { itemId: string; code: SkipCode; reason: string }[];
    /** A correction pass was queued to read the transcript again. */
    correcting: boolean;
}

/**
 * Finish the review of the ready run: apply the ticked items, remember the
 * unticked ones as dismissed, mark the run finished, in one transaction.
 * `versions` are the item versions the person saw; any other is a 409.
 * A transcript changed since the run read it supersedes the run instead.
 */
export async function finishReview(
    access: RecordingViewContext,
    actorUserId: string,
    {
        versions = {},
        source,
    }: { versions?: Record<string, number>; source?: ReviewSource } = {},
): Promise<FinishedReview> {
    const orgUserId = await sharingOrgUserId();
    const latest = await latestRun(access, source);
    if (!latest || latest.status !== "ready") throw reviewNotFound();
    // Where a new record may be found already: what the run could read.
    const readScopes = readableScopes(
        {
            kind: "recording",
            ownerUserId: latest.userId,
            shared: latest.view === "org",
        },
        await getOrgUserId(),
    );
    const finished = await finishInTx(
        latest,
        actorUserId,
        orgUserId,
        versions,
        readScopes,
    );
    if (finished.correcting) nudge();
    // The last review done releases what automatic Learn held back, unless
    // the correction pass it queued is still to run (that releases it).
    await releaseAutoLearnHold(access.recordingId);
    return finished;
}

type LatestRun = NonNullable<Awaited<ReturnType<typeof latestRun>>>;

/** A run on a recording: it read one of its transcripts. */
type RecordingRun = LatestRun & { transcriptionId: string };

function isRecordingRun(run: LatestRun): run is RecordingRun {
    return run.transcriptionId !== null;
}

/** A fact as a finished review confirms it: where it was said or written. */
interface FactPlace {
    startMs?: number;
    endMs?: number;
    text?: MailTextAnchor;
    speakerLabel: string | null;
}

/**
 * What a review's finish reads and writes through, by what its run read:
 * a recording's transcript, or a mail's content. Built under the lock that
 * kind takes, with the writer rule checked there.
 */
interface ReviewSourceInTx {
    revision: number;
    turns: TranscriptTurn[] | null;
    language: () => Promise<string | null>;
    /** The person a speaker label (or a participant) stands for now. */
    speakerPerson: (label: string) => Promise<string | null>;
    confirm: (
        sp: Tx,
        args: {
            relationKey: string;
            subject: KnowledgeTarget;
            object: Exclude<LearnObject, { newRef: string }>;
            place: FactPlace;
            expectedCurrentFactId: string | null;
        },
    ) => Promise<void>;
}

async function transcriptSourceInTx(
    tx: Tx,
    latest: RecordingRun,
    writer: { actorUserId: string; orgUserId: string | null },
): Promise<ReviewSourceInTx> {
    const { revision, turns } = await lockTranscriptForChange(
        tx,
        { userId: latest.userId, transcriptionId: latest.transcriptionId },
        writer,
    );
    return {
        revision,
        turns,
        language: async () =>
            (
                await tx
                    .select({ language: transcriptions.detectedLanguage })
                    .from(transcriptions)
                    .where(eq(transcriptions.id, latest.transcriptionId))
            )[0]?.language ?? null,
        speakerPerson: async (label) => {
            const [row] = await tx
                .select({ personId: transcriptSpeakers.personId })
                .from(transcriptSpeakers)
                .where(
                    and(
                        eq(
                            transcriptSpeakers.transcriptionId,
                            latest.transcriptionId,
                        ),
                        eq(transcriptSpeakers.label, label),
                        eq(transcriptSpeakers.status, "confirmed"),
                    ),
                )
                .limit(1);
            return row?.personId ?? null;
        },
        confirm: async (sp, args) => {
            await confirmFactFromRecordingInTx(sp, {
                ...writer,
                ownerUserId: latest.userId,
                transcriptionId: latest.transcriptionId,
                revision,
                subject: args.subject,
                relationKey: args.relationKey,
                object: args.object,
                startMs: args.place.startMs ?? -1,
                endMs: args.place.endMs ?? -1,
                speakerLabel: args.place.speakerLabel,
                // Replaces only the value the item showed as current (none
                // when it showed none): one changed since is the person's.
                expectedCurrentFactId: args.expectedCurrentFactId,
            });
        },
    };
}

/**
 * A mail's review source: the item locked for update (as sharing and
 * withdrawal lock it), the writer rule checked, its content revision read.
 * A participant stands for the person their address is.
 */
async function mailSourceInTx(
    tx: Tx,
    latest: LatestRun,
    writer: { actorUserId: string; orgUserId: string | null },
): Promise<ReviewSourceInTx> {
    const [item] = await tx
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, latest.itemId),
                eq(chatterItems.userId, latest.userId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .for("update");
    if (!item) throw reviewNotFound();
    const refusal = await contentWriterRefusal(tx, {
        recordingId: latest.itemId,
        ownerUserId: latest.userId,
        actorUserId: writer.actorUserId,
        orgUserId: writer.orgUserId,
    });
    if (refusal) throw writerRefusalError(refusal);
    const [content] = await tx
        .select({
            revision: mailContents.revision,
            language: mailContents.language,
        })
        .from(mailContents)
        .where(
            and(
                eq(mailContents.itemId, latest.itemId),
                eq(mailContents.userId, latest.userId),
            ),
        )
        .limit(1);
    if (!content) throw reviewNotFound();
    return {
        revision: content.revision,
        turns: null,
        language: async () => content.language,
        speakerPerson: async (label) => {
            const [row] = await tx
                .select({ personId: mailParticipants.personId })
                .from(mailParticipants)
                .where(
                    and(
                        eq(mailParticipants.itemId, latest.itemId),
                        eq(mailParticipants.userId, latest.userId),
                        eq(mailParticipants.ref, label),
                    ),
                )
                .limit(1);
            return row?.personId ?? null;
        },
        confirm: async (sp, args) => {
            if (!args.place.text) throw recordMissing();
            await confirmFactFromMailInTx(sp, {
                actorUserId: writer.actorUserId,
                ownerUserId: latest.userId,
                itemId: latest.itemId,
                revision: content.revision,
                text: args.place.text,
                subject: args.subject,
                relationKey: args.relationKey,
                object: args.object,
                speakerLabel: args.place.speakerLabel,
                expectedCurrentFactId: args.expectedCurrentFactId,
            });
        },
    };
}

/**
 * A mail's participant as the person a review added or found for them:
 * linked on the mail, and their address the person's email when the person
 * has none, another address of theirs otherwise. The address is known in
 * the scope the review writes in: an Organization person a member's
 * private mail names gets no address of the mail's, the member knows it
 * as theirs (a correspondent reaches the Organization only by sharing).
 */
async function linkParticipantInTx(
    tx: Tx,
    run: LatestRun,
    writerUserId: string,
    link: { ref: string; personId: string; address: string | null },
): Promise<void> {
    const [participant] = await tx
        .update(mailParticipants)
        .set({ personId: link.personId })
        .where(
            and(
                eq(mailParticipants.itemId, run.itemId),
                eq(mailParticipants.userId, run.userId),
                eq(mailParticipants.ref, link.ref),
                isNull(mailParticipants.personId),
            ),
        )
        .returning({ address: mailParticipants.address });
    const email =
        link.address ??
        (participant?.address ? decryptText(participant.address) : null);
    if (!email) return;
    const hash = lookupHash(email);
    try {
        await tx.transaction(async (sp) => {
            const [person] = await sp
                .select({
                    userId: people.userId,
                    primaryEmailHash: people.primaryEmailHash,
                })
                .from(people)
                .where(eq(people.id, link.personId))
                .limit(1);
            if (!person || person.primaryEmailHash === hash) return;
            if (
                person.userId === writerUserId &&
                person.primaryEmailHash === null
            ) {
                await sp
                    .update(people)
                    .set({
                        primaryEmail: encryptText(email),
                        primaryEmailHash: hash,
                    })
                    .where(eq(people.id, link.personId));
                return;
            }
            // Another address of theirs: what their next mail is known by.
            await sp
                .insert(personEmails)
                .values({
                    userId: writerUserId,
                    personId: link.personId,
                    emailHash: hash,
                    email: encryptText(email),
                })
                .onConflictDoNothing();
        });
    } catch (error) {
        if (!isUniqueViolation(error)) throw error;
    }
}

function finishInTx(
    latest: LatestRun,
    actorUserId: string,
    orgUserId: Awaited<ReturnType<typeof sharingOrgUserId>>,
    versions: Record<string, number>,
    readScopes: readonly string[],
): Promise<FinishedReview> {
    return db.transaction(async (tx) => {
        await lockOrgPeopleShared(tx);
        const source = isRecordingRun(latest)
            ? await transcriptSourceInTx(tx, latest, {
                  actorUserId,
                  orgUserId,
              })
            : await mailSourceInTx(tx, latest, { actorUserId, orgUserId });
        const { revision, turns } = source;
        const [run] = await tx
            .select()
            .from(learnRuns)
            .where(eq(learnRuns.id, latest.id))
            .for("update");
        if (!run || run.status !== "ready") throw reviewNotFound();
        if (revision !== run.transcriptRevision) {
            await tx
                .update(learnRuns)
                .set({ status: "superseded", updatedAt: new Date() })
                .where(eq(learnRuns.id, run.id));
            return {
                status: "superseded",
                applied: 0,
                dismissed: 0,
                skipped: [],
                correcting: false,
            };
        }
        const rows = await tx
            .select()
            .from(learnReviewItems)
            .where(eq(learnReviewItems.runId, run.id))
            .for("update");
        // Every item as the person saw it, and nothing else: a default
        // applied to an item they never loaded is no decision of theirs.
        const shown = Object.keys(versions);
        if (
            shown.length !== rows.length ||
            rows.some((row) => versions[row.id] !== row.version)
        ) {
            throw new AppError(
                ErrorCode.CONFLICT,
                "The review changed; reload it",
                409,
            );
        }
        const items = rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            fingerprintHmac: row.fingerprintHmac,
            /** Rejected by the reviewer, not merely left unticked. */
            rejectedOutright: row.decision === "rejected",
            accepted:
                (row.decision ?? (row.preTicked ? "accepted" : "rejected")) ===
                "accepted",
            choice: row.choice
                ? decryptJsonField<ReviewChoice>(row.choice)
                : null,
            payload: decryptJsonField<
                ReviewCandidate["payload"] | MailReviewCandidate["payload"]
            >(row.payload),
        }));

        const scopes = new Set<string>([actorUserId]);
        const skipped: FinishedReview["skipped"] = [];
        let applied = 0;
        /** Apply one item in a savepoint; false when it was skipped. */
        const attempt = async (
            itemId: string,
            apply: (sp: Tx) => Promise<void>,
        ): Promise<boolean> => {
            try {
                await tx.transaction(async (sp) => apply(sp as Tx));
                applied++;
                return true;
            } catch (error) {
                if (error instanceof AppError) {
                    skipped.push({
                        itemId,
                        code:
                            error.code === ErrorCode.CONFLICT
                                ? "changed"
                                : "no_longer_fits",
                        reason: error.message,
                    });
                    return false;
                }
                // A name taken meanwhile by another transaction.
                if (isUniqueViolation(error)) {
                    skipped.push({
                        itemId,
                        code: "already_exists",
                        reason: "Already exists",
                    });
                    return false;
                }
                throw error;
            }
        };
        const skip = (itemId: string, code: SkipCode, reason: string) => {
            skipped.push({ itemId, code, reason });
        };
        const writer = { actorUserId, orgUserId };

        // New people and things first: the items that refer to one by its
        // ref are applied to the record it became.
        const refs = new Map<string, RecordTarget>();
        const records = items.filter(
            (item) => item.kind === "new_record" && item.accepted,
        );
        // People have no unique name: two reviews adding one person at once
        // take turns by name (in one order, so they never wait on each
        // other), and each looks for the person once its turn comes. A
        // name is locked in every scope this review reads, so a member's
        // review and the Organization's take turns too.
        const personNames = [
            ...new Set(
                records.flatMap((item) => {
                    const payload = item.payload as NewRecordPayload;
                    const choice = item.choice;
                    if (payload.kind !== "person") return [];
                    if (choice && "personId" in choice) return [];
                    return [
                        recordNameKey(
                            choice && "name" in choice
                                ? choice.name
                                : payload.name,
                        ),
                    ];
                }),
            ),
        ];
        const personLocks = [
            ...new Set(
                personNames.flatMap((nameKey) =>
                    [...new Set([actorUserId, ...readScopes])].map(
                        (scope) =>
                            `riffado:learn-person:${domainLookupHash("learn-person", `${scope}\u0000${nameKey}`)}`,
                    ),
                ),
            ),
        ].sort();
        for (const key of personLocks) {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${key}))`,
            );
        }
        const peopleByName =
            personNames.length > 0
                ? await peopleNamedInTx(tx, readScopes)
                : new Map<string, string[]>();
        /** The transcript's language, read once a nickname may be kept. */
        let language: string | null | undefined;
        for (const item of records) {
            const payload = item.payload as NewRecordPayload;
            const choice = item.choice;
            if (choice && ("personId" in choice || "entityId" in choice)) {
                // The reviewer said which record it is (or the one it was
                // merged into since).
                const chosen: RecordTarget =
                    "personId" in choice
                        ? { personId: choice.personId }
                        : { entityId: choice.entityId };
                const target = await resolveTargetInTx(
                    tx,
                    actorUserId,
                    chosen,
                ).catch((error: unknown) => {
                    if (error instanceof AppError) return null;
                    throw error;
                });
                const known =
                    target &&
                    "personId" in target === (payload.kind === "person")
                        ? await readableRecordNameInTx(tx, target, readScopes)
                        : null;
                if (known === null || !target) {
                    skip(item.id, "no_longer_fits", "No such record here");
                    continue;
                }
                refs.set(payload.ref, target);
                applied++;
                // What Learn heard becomes the record's nickname, so the
                // next run finds it ("Honza" for Jan). A name it already
                // has, or one the actor cannot name, is no loss.
                language ??= await source.language();
                if (
                    nicknameWorthKeeping(payload.name, known, language ?? null)
                ) {
                    try {
                        await tx.transaction(async (sp) => {
                            await addAliasInTx(
                                sp as Tx,
                                actorUserId,
                                target,
                                payload.name,
                            );
                        });
                    } catch (error) {
                        if (!(error instanceof AppError)) throw error;
                    }
                }
                continue;
            }
            const renamed = choice && "name" in choice ? choice : null;
            const name = renamed?.name ?? payload.name;
            const typeKey =
                payload.kind === "person"
                    ? null
                    : (renamed?.typeKey ?? payload.typeKey);
            // Added since the run looked (by hand, or another review).
            const existing = await existingRecordInTx(
                tx,
                { kind: payload.kind, typeKey, name },
                readScopes,
                peopleByName,
            );
            if (existing) {
                refs.set(payload.ref, existing);
                skip(item.id, "already_exists", "Already in the Almanac");
                continue;
            }
            if (payload.kind === "entity" && !typeKey) {
                skip(item.id, "no_longer_fits", "A thing needs a type");
                continue;
            }
            const made: { target?: RecordTarget } = {};
            const added = await attempt(item.id, async (sp) => {
                await assertOwnScopeWritable(actorUserId);
                if (payload.kind === "person" || !typeKey) {
                    const person = await createPersonInTx(sp, {
                        userId: actorUserId,
                        displayName: name,
                        createdByUserId: actorUserId,
                    });
                    made.target = { personId: person.id };
                    // Another ticked record of that name is this person.
                    peopleByName.set(recordNameKey(name), [person.id]);
                } else {
                    made.target = {
                        entityId: await createEntityInTx(sp, actorUserId, {
                            typeKey,
                            name,
                        }),
                    };
                }
            });
            if (added && made.target) {
                refs.set(payload.ref, made.target);
                continue;
            }
            // Its name taken meanwhile: that thing is the one.
            const taken =
                typeKey !== null && payload.kind === "entity"
                    ? await findEntityByNameInTx(tx, actorUserId, typeKey, name)
                    : null;
            if (taken) {
                refs.set(payload.ref, { entityId: taken });
                const entry = skipped.find((one) => one.itemId === item.id);
                if (entry) entry.code = "already_exists";
            }
        }
        // On a mail, a person added for a participant (or found as them)
        // is that participant from now on, their address their email.
        if (!isRecordingRun(latest)) {
            for (const item of records) {
                const payload = item.payload as MailNewRecordPayload;
                const target = refs.get(payload.ref);
                if (
                    !payload.speakerLabel ||
                    !target ||
                    !("personId" in target)
                ) {
                    continue;
                }
                await linkParticipantInTx(tx, latest, actorUserId, {
                    ref: payload.speakerLabel,
                    personId: target.personId,
                    address: payload.address ?? null,
                });
            }
        }
        /** An item's payload on the records its refs became, or null. */
        const onRecords = <T>(payload: T): T | null =>
            replaceRefs(payload, (ref) => refs.get(ref));
        const notAdded = (itemId: string) =>
            skip(itemId, "record_not_added", "A record it needs was not added");

        // Speakers next: the facts that depend on them read their answer.
        // A mail has neither speakers nor corrections.
        const transcript = isRecordingRun(latest)
            ? {
                  userId: run.userId,
                  transcriptionId: latest.transcriptionId,
                  revision,
              }
            : null;
        for (const item of items) {
            if (item.kind !== "speaker" || !item.accepted || !transcript) {
                continue;
            }
            const payload = item.payload as Extract<
                ReviewCandidate,
                { kind: "speaker" }
            >["payload"];
            const choice = item.choice;
            // A person the same review adds, whom the run heard speak.
            const added = payload.newRef ? refs.get(payload.newRef) : undefined;
            const answer: SpeakerAnswer | null =
                choice && "unknown" in choice
                    ? { kind: "unknown" }
                    : choice && "personId" in choice
                      ? { kind: "name", personId: choice.personId }
                      : choice && "displayName" in choice
                        ? { kind: "name", displayName: choice.displayName }
                        : payload.personId
                          ? { kind: "name", personId: payload.personId }
                          : added && "personId" in added
                            ? { kind: "name", personId: added.personId }
                            : null;
            if (!answer) {
                if (payload.newRef) {
                    notAdded(item.id);
                    continue;
                }
                skipped.push({
                    itemId: item.id,
                    code: "nobody_chosen",
                    reason: "Nobody chosen",
                });
                continue;
            }
            // Proposed for a label nobody had answered; an answer given
            // since is the person's, and stays.
            const [answered] = await tx
                .select({ id: transcriptSpeakers.id })
                .from(transcriptSpeakers)
                .where(
                    and(
                        eq(
                            transcriptSpeakers.transcriptionId,
                            transcript.transcriptionId,
                        ),
                        eq(transcriptSpeakers.label, payload.label),
                        or(
                            eq(transcriptSpeakers.status, "confirmed"),
                            eq(transcriptSpeakers.markedUnknown, true),
                        ),
                    ),
                )
                .limit(1);
            if (answered) {
                skipped.push({
                    itemId: item.id,
                    code: "answered_since",
                    reason: "Answered since",
                });
                continue;
            }
            await attempt(item.id, async (sp) => {
                await answerSpeakerInTx(
                    sp,
                    {
                        ...writer,
                        ...transcript,
                        label: payload.label,
                        answer,
                    },
                    scopes,
                );
            });
        }

        for (const item of items) {
            if (item.kind !== "correction" || !item.accepted || !transcript) {
                continue;
            }
            const payload = onRecords(
                item.payload as Extract<
                    ReviewCandidate,
                    { kind: "correction" }
                >["payload"],
            );
            if (!payload) {
                notAdded(item.id);
                continue;
            }
            const target = payload.target;
            if ("newRef" in target) {
                notAdded(item.id);
                continue;
            }
            // All its occurrences or none. The item groups them by their
            // words in any case; each is applied at its own.
            await attempt(item.id, async (sp) => {
                for (const anchor of payload.anchors) {
                    await acceptCorrectionInTx(sp, {
                        ...writer,
                        ...transcript,
                        anchor: {
                            ...anchor,
                            heard:
                                wordsAt(
                                    turns?.[anchor.turnIndex]?.text,
                                    anchor.charStart,
                                    anchor.charEnd,
                                    payload.heard,
                                ) ?? payload.heard,
                        },
                        kind: payload.kind,
                        target,
                        replacement: payload.replacement,
                    });
                }
            });
        }

        /** Whom a fact's speaker-bound side names now, or null. */
        const speakerPerson = (label: string) => source.speakerPerson(label);
        const resolveSubject = async (
            subject: LearnSubject,
        ): Promise<KnowledgeTarget | null> => {
            // Only once `onRecords` replaced it, which it did or skipped.
            if ("newRef" in subject) return null;
            if (!("speakerLabel" in subject)) return subject;
            const personId = await speakerPerson(subject.speakerLabel);
            return personId ? { personId } : null;
        };
        const confirm = async (
            sp: Tx,
            relationKey: string,
            subject: KnowledgeTarget,
            object: LearnObject,
            fact: FactPlace,
            expectedCurrentFactId: string | null,
        ) => {
            if ("newRef" in object) throw recordMissing();
            await source.confirm(sp, {
                relationKey,
                subject,
                object,
                place: fact,
                expectedCurrentFactId,
            });
        };

        for (const item of items) {
            if (
                (item.kind !== "fact" && item.kind !== "known_fact") ||
                !item.accepted
            ) {
                continue;
            }
            const payload = onRecords(
                item.payload as Extract<
                    ReviewCandidate,
                    { kind: "fact" | "known_fact" }
                >["payload"],
            );
            if (!payload) {
                notAdded(item.id);
                continue;
            }
            // A known fact of another scope (the Organization's, on a
            // private recording) is not copied into the actor's.
            if (item.kind === "known_fact" && payload.factId) {
                const [known] = await tx
                    .select({ userId: knowledgeFacts.userId })
                    .from(knowledgeFacts)
                    .where(eq(knowledgeFacts.id, payload.factId))
                    .limit(1);
                if (known?.userId !== run.scopeUserId) {
                    skipped.push({
                        itemId: item.id,
                        code: "known_elsewhere",
                        reason: "Known in another scope",
                    });
                    continue;
                }
            }
            // A fact about a speaker, or said by one, holds only once that
            // speaker is named, and its evidence stays tied to them.
            const speakerLabel = speakerOf(payload);
            const subject = await resolveSubject(payload.subject);
            if (
                !subject ||
                (speakerLabel !== null && !(await speakerPerson(speakerLabel)))
            ) {
                skipped.push({
                    itemId: item.id,
                    code: "speaker_not_named",
                    reason: "Its speaker is not named yet",
                });
                continue;
            }
            const expected =
                item.kind === "known_fact"
                    ? (payload.factId ?? null)
                    : (payload.replaces?.factId ?? null);
            await attempt(item.id, (sp) =>
                confirm(
                    sp,
                    payload.relationKey,
                    subject,
                    payload.object,
                    { ...payload, speakerLabel },
                    expected,
                ),
            );
        }

        const organization = orgUserId !== null && actorUserId === orgUserId;
        const phrases = items.flatMap((item) => {
            if (item.kind !== "relation_phrase" || !item.accepted) return [];
            const proposed = item.payload as Extract<
                ReviewCandidate,
                { kind: "relation_phrase" }
            >["payload"];
            // The relation needs none of its sides; only its first fact
            // does, and is left out when a side was not added.
            const payload = onRecords(proposed) ?? proposed;
            return [{ item, payload, choice: item.choice }];
        });
        // Suggestions first, then new types: every finish takes the
        // proposal rows before the vocabulary's version row, so two never
        // wait on each other the wrong way round.
        for (const { item, payload, choice } of phrases) {
            if (
                !(choice && "action" in choice && choice.action === "suggest")
            ) {
                continue;
            }
            await attempt(item.id, (sp) =>
                proposePhraseInTx(sp, actorUserId, payload.phrase),
            );
        }
        let typesCreated = false;
        for (const { item, payload, choice } of phrases) {
            if (choice && "action" in choice && choice.action === "suggest") {
                continue;
            }
            if (!(choice && "action" in choice && choice.action === "create")) {
                skipped.push({
                    itemId: item.id,
                    code: "nothing_chosen",
                    reason: "Nothing chosen",
                });
                continue;
            }
            const subject = await resolveSubject(payload.subject);
            const speakerLabel =
                "speakerLabel" in payload.subject
                    ? payload.subject.speakerLabel
                    : null;
            await attempt(item.id, async (sp) => {
                const key = await createOwnTypeInTx(
                    sp,
                    actorUserId,
                    organization,
                    choice.spec,
                );
                typesCreated = true;
                // The relation works at once: the words that named it are
                // its first fact, where it takes them (never text, which a
                // review item does not keep). In a savepoint of its own, so
                // the type stays when the fact does not fit it.
                const object = payload.object;
                if (subject && object) {
                    await sp
                        .transaction((inner) =>
                            confirm(
                                inner as Tx,
                                key,
                                subject,
                                object,
                                { ...payload, speakerLabel },
                                null,
                            ),
                        )
                        .catch((error: unknown) => {
                            if (!(error instanceof AppError)) throw error;
                        });
                }
            });
        }

        const rejected = items.filter((item) => !item.accepted);
        if (rejected.length > 0) {
            await tx
                .insert(learnDismissals)
                .values(
                    rejected.map((item) => ({
                        userId: run.scopeUserId,
                        itemId: run.itemId,
                        fingerprintHmac: item.fingerprintHmac,
                        // A new record the reviewer rejected is not
                        // proposed again on any recording; one merely left
                        // unticked, only not on this one.
                        scopeWide:
                            item.kind === "new_record" && item.rejectedOutright,
                    })),
                )
                .onConflictDoNothing();
        }
        // What became of each item, for the review to show once finished.
        // Every ticked item was either applied or skipped with a code.
        const skippedCode = new Map(
            skipped.map((entry) => [entry.itemId, entry.code]),
        );
        const byOutcome = new Map<ItemOutcome, string[]>();
        for (const item of items) {
            const outcome: ItemOutcome = !item.accepted
                ? "rejected"
                : (skippedCode.get(item.id) ?? "applied");
            byOutcome.set(outcome, [
                ...(byOutcome.get(outcome) ?? []),
                item.id,
            ]);
        }
        for (const [outcome, ids] of byOutcome) {
            await tx
                .update(learnReviewItems)
                .set({ outcome })
                .where(inArray(learnReviewItems.id, ids));
        }
        await tx
            .update(learnRuns)
            .set({
                status: "finished",
                finishedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(eq(learnRuns.id, run.id));
        // Once, after every type the finish made (`createOwnTypeInTx`).
        if (typesCreated) await bumpVocabularyVersionInTx(tx);
        await bumpScopeInTx(tx, scopes);
        const correcting = isRecordingRun(latest)
            ? await queueCorrectionPassInTx(tx, {
                  ...run,
                  transcriptionId: latest.transcriptionId,
              })
            : false;
        return {
            status: "finished",
            applied,
            dismissed: rejected.length,
            skipped,
            correcting,
        };
    });
}
