/**
 * Running a Learn run (job kind `learn.run`): read the transcript the run
 * was started on, find what it says through the run's scopes, validate
 * the answer against the run, and store what holds as review items for a
 * person to decide on. Nothing here changes knowledge: the review does.
 *
 * The run goes nowhere when it no longer should: a changed transcript
 * supersedes it; a recording that was shared, withdrawn or deleted since,
 * so that the actor may no longer change it in the run's view, cancels it.
 * Both are checked again under the recording lock where the items are
 * written. The provider is the actor's, who pays; path 2 (no tools) until
 * the bridge path lands (Task 3.6).
 */

import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    knowledgeAliases,
    knowledgeScopeGenerations,
    knowledgeVocabularyVersion,
    learnDismissals,
    learnReviewItems,
    learnRuns,
    recordings,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import { decryptText, encryptJsonField } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { nudge } from "@/lib/jobs/nudge";
import { isRetryableError } from "@/lib/jobs/retryable";
import type { JobHandler, JobResult } from "@/lib/jobs/types";
import { listCorrections } from "@/lib/knowledge/corrections";
import { nodeKey } from "@/lib/knowledge/fact-rules";
import { objectKeyOf } from "@/lib/knowledge/facts";
import { knowledgeView } from "@/lib/knowledge/knowledge-loader";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { findPersonByEmail } from "@/lib/knowledge/people";
import { readableScopes } from "@/lib/knowledge/scope";
import { vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";
import { releaseAutoLearnHold } from "@/lib/learn/auto-learn";
import { learnChatClients } from "@/lib/learn/chat-clients";
import { queueCorrectionPassInTx } from "@/lib/learn/correction-pass-queue";
import { isFinalLearnError } from "@/lib/learn/errors";
import {
    LEARN_JOB_KIND,
    LEARN_MAX_ATTEMPTS,
    type LearnJobPayload,
    parseLearnJobPayload,
} from "@/lib/learn/learn-job";
import type { LearnObject } from "@/lib/learn/output";
import { chooseLearnPath } from "@/lib/learn/provider";
import { runBridgePass } from "@/lib/learn/run-bridge";
import {
    type LearnEntityTypeChoice,
    type LearnRelationChoice,
    runFallbackPass,
} from "@/lib/learn/run-fallback";
import { issueLearnRunToken } from "@/lib/learn/run-token";
import { findEntities, type LearnToolContext } from "@/lib/learn/tools";
import {
    currentFactKey,
    factKey,
    heardAsKey,
    type LearnRunFrame,
    type ReviewCandidate,
    validateLearnOutput,
} from "@/lib/learn/validate";
import { contentWriterRefusal, sharingOrgUserId } from "@/lib/sharing/writer";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";

const FINGERPRINT_DOMAIN = "learn-fingerprint";
/**
 * Knowledge lookups one run may make: room for every distinct mention of a
 * long recording (up to 40 a window, four windows for about two hours),
 * and for two other forms of each (`runFallbackPass` keeps the later
 * windows' share). The pilot's 60 ran
 * out on every recording over half an hour, and the later windows were
 * adjudicated knowing nothing.
 */
const TOOL_BUDGET = 480;
/**
 * How often a run validates again when what it validated against changed
 * before the items were written; the last time, it writes without
 * pre-ticking anything.
 */
const FENCE_ATTEMPTS = 3;

/** How a review item's fingerprint is stored: a keyed HMAC. */
export function learnFingerprintHmac(fingerprint: string): string {
    return domainLookupHash(FINGERPRINT_DOMAIN, fingerprint);
}

/** A run on a recording: it read one of its transcripts. */
type RunRow = typeof learnRuns.$inferSelect & { transcriptionId: string };

function isRecordingRun(run: typeof learnRuns.$inferSelect): run is RunRow {
    return run.transcriptionId !== null;
}

/**
 * What a person rejected that a run in their scope must not propose again:
 * on this recording, and new records on any.
 */
function dismissalsFor(run: RunRow) {
    return and(
        eq(learnDismissals.userId, run.scopeUserId),
        or(
            eq(learnDismissals.itemId, run.itemId),
            eq(learnDismissals.scopeWide, true),
        ),
    );
}
type Outcome =
    | "ready"
    | "finished"
    | "superseded"
    | "cancelled"
    | "failed"
    | "queued";

/**
 * Leave the run this attempt claimed: only while it is still `running`, so
 * a status someone else set meanwhile (superseded by a rewrite, cancelled,
 * or claimed again by a later attempt) is never overwritten.
 */
async function setStatus(
    runId: string,
    status: Outcome,
    extra: Partial<typeof learnRuns.$inferInsert> = {},
): Promise<void> {
    await db
        .update(learnRuns)
        .set({ status, updatedAt: new Date(), ...extra })
        .where(and(eq(learnRuns.id, runId), eq(learnRuns.status, "running")));
}

/** The actor's chat provider, as the Learn pass talks to it. */
function chatFor(run: RunRow, signal: AbortSignal) {
    return learnChatClients({
        actorUserId: run.actorUserId ?? "",
        recordingId: run.itemId,
        ownerUserId: run.userId,
        operation: "learn",
        schemaName: "learn_output",
        signal,
    });
}

/**
 * Whether the actor may still change the recording in the run's view: the
 * writer rule, and the view the run was started in. `orgUserId` is
 * resolved by the caller, outside any transaction (`sharingOrgUserId`).
 */
export async function mayStillRun(
    run: Pick<RunRow, "actorUserId" | "itemId" | "userId" | "view">,
    orgUserId: string | null,
    executor?: Parameters<typeof contentWriterRefusal>[0],
): Promise<boolean> {
    if (!run.actorUserId) return false;
    const refusal = await contentWriterRefusal(executor, {
        recordingId: run.itemId,
        ownerUserId: run.userId,
        actorUserId: run.actorUserId,
        orgUserId,
    });
    if (refusal) return false;
    return run.view === "private"
        ? run.actorUserId === run.userId
        : orgUserId !== null && run.actorUserId === orgUserId;
}

type Executor = Pick<typeof db, "select">;

/**
 * What a validation depended on, as one comparable value: the generations
 * of the scopes the run reads, the vocabulary's version, the answers given
 * on the transcript's speakers and the recording's dismissals. Read before
 * the frame, and again under the locks the items are written under: when
 * the two differ, the frame may be stale (an entity deleted, an alias taken
 * back, a speaker answered) and the run validates again.
 */
async function fenceOf(
    executor: Executor,
    run: RunRow,
    orgUserId: string | null,
    { lock = false }: { lock?: boolean } = {},
): Promise<string> {
    const scopes = readableScopes(
        {
            kind: "recording",
            ownerUserId: run.userId,
            shared: run.view === "org",
        },
        orgUserId,
    );
    // Under the write, the counters are held for share: a change that has
    // bumped them and not yet committed is waited for, and then seen. In
    // the order writers take them (the vocabulary's version first, the
    // scope generations last), so the two never wait on each other.
    const versioned = executor
        .select({ version: knowledgeVocabularyVersion.version })
        .from(knowledgeVocabularyVersion)
        .where(eq(knowledgeVocabularyVersion.id, 1));
    const [vocabulary] = await (lock ? versioned.for("share") : versioned);
    const generations = new Map(scopes.map((scope) => [scope, 0]));
    const counted = executor
        .select({
            userId: knowledgeScopeGenerations.userId,
            generation: knowledgeScopeGenerations.generation,
        })
        .from(knowledgeScopeGenerations)
        .where(inArray(knowledgeScopeGenerations.userId, scopes))
        // The order `bumpScopeInTx` sorts in (code units), whatever the
        // database's collation.
        .orderBy(sql`${knowledgeScopeGenerations.userId} collate "C"`);
    for (const row of await (lock ? counted.for("share") : counted)) {
        generations.set(row.userId, row.generation);
    }
    const answered = await executor
        .select({
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            status: transcriptSpeakers.status,
            markedUnknown: transcriptSpeakers.markedUnknown,
        })
        .from(transcriptSpeakers)
        .where(eq(transcriptSpeakers.transcriptionId, run.transcriptionId))
        .orderBy(asc(transcriptSpeakers.label));
    const dismissed = await executor
        .select({ hmac: learnDismissals.fingerprintHmac })
        .from(learnDismissals)
        .where(dismissalsFor(run))
        .orderBy(asc(learnDismissals.fingerprintHmac));
    return JSON.stringify([
        [...generations.entries()].sort(),
        vocabulary?.version ?? 0,
        answered,
        dismissed.map((row) => row.hmac),
    ]);
}

/**
 * A heard form and the name its correction wrote, as compared: in its own
 * language and transcription provider, as a heard form is kept.
 */
function heardFormKey(
    target: { personId: string } | { entityId: string },
    heard: string,
    wrote: string,
    language: string | null,
    provider: string | null,
): string {
    const fold = (text: string) => text.trim().normalize("NFC").toLowerCase();
    return JSON.stringify([
        "personId" in target ? target.personId : target.entityId,
        fold(heard),
        fold(wrote),
        language ?? "",
        provider ?? "",
    ]);
}

/**
 * The heard forms in the run's scopes whose correction wrote the record's
 * name exactly (`heardFormKey` of heard, target, what it wrote, language
 * and provider).
 */
async function heardFormsWritingName(
    run: RunRow,
    shared: boolean,
): Promise<Set<string>> {
    const scopes = readableScopes(
        { kind: "recording", ownerUserId: run.userId, shared },
        await sharingOrgUserId(),
    );
    const rows = await db
        .select({
            text: knowledgeAliases.text,
            personId: knowledgeAliases.personId,
            entityId: knowledgeAliases.entityId,
            language: knowledgeAliases.language,
            provider: knowledgeAliases.provider,
            replacement: transcriptCorrections.replacement,
        })
        .from(knowledgeAliases)
        .innerJoin(
            transcriptCorrections,
            eq(transcriptCorrections.id, knowledgeAliases.correctionId),
        )
        .where(
            and(
                eq(knowledgeAliases.kind, "heard_as"),
                inArray(knowledgeAliases.userId, scopes),
            ),
        );
    const found = new Set<string>();
    for (const row of rows) {
        if (!row.replacement) continue;
        const target = row.personId
            ? { personId: row.personId }
            : { entityId: row.entityId ?? "" };
        found.add(
            heardFormKey(
                target,
                decryptText(row.text),
                decryptText(row.replacement),
                row.language,
                row.provider,
            ),
        );
    }
    return found;
}

/**
 * The person who made the recording: the record in the run's scopes that
 * carries the recording owner's account email. Null without one.
 */
async function recorderOf(
    run: RunRow,
    people: ReadonlyMap<string, { name: string }>,
): Promise<{ personId: string; name: string } | null> {
    const [owner] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, run.userId))
        .limit(1);
    if (!owner?.email) return null;
    const person = await findPersonByEmail(run.userId, owner.email);
    const known = person ? people.get(person.id) : undefined;
    return person && known ? { personId: person.id, name: known.name } : null;
}

/** Everything the validation needs to know of the run's scopes, frozen now. */
async function frameFor(
    run: RunRow,
    transcript: {
        revision: number;
        turns: NonNullable<ReturnType<typeof readTranscriptTurns>>;
        language: string | null;
        provider: string | null;
    },
): Promise<LearnRunFrame> {
    const shared = run.view === "org";
    const view = await knowledgeView({
        kind: "recording",
        ownerUserId: run.userId,
        shared,
    });
    const vocabulary = await vocabularyVisibleTo(run.scopeUserId, {
        sharedOnly: shared,
    });
    const answered = await db
        .select({
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            status: transcriptSpeakers.status,
            markedUnknown: transcriptSpeakers.markedUnknown,
        })
        .from(transcriptSpeakers)
        .where(eq(transcriptSpeakers.transcriptionId, run.transcriptionId));
    const dismissed = await db
        .select({ hmac: learnDismissals.fingerprintHmac })
        .from(learnDismissals)
        .where(dismissalsFor(run));
    const people = new Map<string, { name: string; aliases: string[] }>();
    const entities = new Map<
        string,
        { typeKey: string; name: string; aliases: string[] }
    >();
    // A heard form pre-ticks only a rewrite the person accepted word for
    // word: their correction wrote exactly the record's name. One they
    // accepted in another grammatical form ("Terradomě" for "Terra doma")
    // says nothing about the base name elsewhere.
    const wroteName = await heardFormsWritingName(run, shared);
    const confirmedHeardAs = new Set<string>();
    for (const item of view.items) {
        const aliases = item.names
            .filter((name) => name.kind === "alias")
            .map((name) => name.text);
        if (item.kind === "person") {
            people.set(item.id, { name: item.name, aliases });
        } else {
            entities.set(item.id, {
                typeKey: item.typeKey,
                name: item.name,
                aliases,
            });
        }
        for (const name of item.names) {
            if (name.kind !== "heard_as") continue;
            if (
                !wroteName.has(
                    heardFormKey(
                        name.target,
                        name.text,
                        item.name,
                        name.language,
                        name.provider,
                    ),
                )
            ) {
                continue;
            }
            confirmedHeardAs.add(
                heardAsKey(
                    name.target,
                    name.text,
                    name.language,
                    name.provider,
                ),
            );
        }
    }
    const literalKey = (literal: string) => objectKeyOf({ literal });
    // The run writes its own scope: the owner's on a private recording,
    // the Organization's on a shared one.
    const ownScope = shared ? "org" : "personal";
    const knownFacts = new Map<string, string>();
    const foreignFacts = new Set<string>();
    const currentFacts = new Map<
        string,
        { factId: string; object: LearnObject }
    >();
    for (const fact of view.facts) {
        const key = factKey(
            nodeKey(fact.subject),
            fact.relationKey,
            "literal" in fact.object
                ? literalKey(fact.object.literal)
                : nodeKey(fact.object),
        );
        if (fact.scope !== ownScope) {
            foreignFacts.add(key);
            continue;
        }
        knownFacts.set(key, fact.id);
        currentFacts.set(
            currentFactKey(nodeKey(fact.subject), fact.relationKey),
            { factId: fact.id, object: fact.object },
        );
    }
    const recorder = await recorderOf(run, people);
    return {
        revision: run.transcriptRevision,
        currentRevision: transcript.revision,
        transcriptKey: `${run.transcriptionId}@${run.transcriptRevision}`,
        turns: transcript.turns,
        language: transcript.language,
        provider: transcript.provider,
        people,
        entities,
        entityTypes: new Set(newThingTypes(vocabulary).map((type) => type.key)),
        relations: new Map(
            vocabulary.relationTypes
                .filter((relation) => !relation.adoptedAsKey)
                .map((relation) => [relation.key, relation]),
        ),
        answeredLabels: new Map(
            answered
                .filter(
                    (row) => row.status === "confirmed" || row.markedUnknown,
                )
                .map((row) => [
                    row.label,
                    row.markedUnknown ? null : row.personId,
                ]),
        ),
        recorderPersonId: recorder?.personId ?? null,
        confirmedHeardAs,
        knownFacts,
        foreignFacts,
        currentFacts,
        // The words that already carry a confirmed correction, as everyone
        // reading the transcript in its view sees them.
        corrected: (
            await listCorrections(run.userId, run.transcriptionId, db, {
                shared: run.view === "org",
            })
        ).map(({ turnIndex, charStart, charEnd }) => ({
            turnIndex,
            charStart,
            charEnd,
        })),
        dismissed: new Set(dismissed.map((row) => row.hmac)),
        fingerprintKey: learnFingerprintHmac,
        literalKey,
    };
}

/** The types a new thing may take: the scope's, but no adopted private one. */
function newThingTypes(
    vocabulary: Awaited<ReturnType<typeof vocabularyVisibleTo>>,
): LearnEntityTypeChoice[] {
    return vocabulary.entityTypes
        .filter((type) => type.key !== "person" && !type.adoptedAsKey)
        .map((type) => ({ key: type.key, label: type.label }));
}

function counts(
    items: readonly ReviewCandidate[],
    extra: Record<string, number>,
): Record<string, number> {
    const stats: Record<string, number> = { ...extra, items: items.length };
    for (const item of items) {
        stats[`items_${item.kind}`] = (stats[`items_${item.kind}`] ?? 0) + 1;
    }
    return stats;
}

/**
 * Whatever a run ended with, short of waiting for its review, may release
 * the title, summary and topics automatic Learn held back (Task 5.5).
 */
async function settled(runId: string): Promise<void> {
    const [run] = await db
        .select({
            recordingId: learnRuns.itemId,
            status: learnRuns.status,
        })
        .from(learnRuns)
        .where(eq(learnRuns.id, runId));
    if (!run || run.status === "queued" || run.status === "running") return;
    await releaseAutoLearnHold(run.recordingId);
}

export const learnJobHandler: JobHandler<LearnJobPayload> = {
    kind: LEARN_JOB_KIND,
    // One at a time: runs go to the same providers as summaries.
    concurrency: 1,
    maxAttempts: LEARN_MAX_ATTEMPTS,
    timeoutMs: 20 * 60 * 1000,
    backoff: { baseMs: 30_000, maxMs: 10 * 60_000, jitter: 0.3 },
    parsePayload: parseLearnJobPayload,

    async run(context): Promise<JobResult> {
        try {
            return await runLearnJob(context);
        } finally {
            await settled(context.payload.runId).catch(() => undefined);
        }
    },
};

async function runLearnJob({
    payload,
    attempt,
    maxAttempts,
    signal,
    reportProgress,
}: Parameters<JobHandler<LearnJobPayload>["run"]>[0]): Promise<JobResult> {
    const [run] = await db
        .select()
        .from(learnRuns)
        .where(eq(learnRuns.id, payload.runId));
    if (!run) return { skipped: "gone" };
    if (run.status !== "queued" && run.status !== "running") {
        return { skipped: run.status };
    }
    if (!isRecordingRun(run)) {
        await db
            .update(learnRuns)
            .set({ status: "cancelled", updatedAt: new Date() })
            .where(eq(learnRuns.id, run.id));
        return { skipped: "unsupported kind" };
    }
    const claimed = await db
        .update(learnRuns)
        .set({
            status: "running",
            startedAt: new Date(),
            updatedAt: new Date(),
            // Each attempt looks things up afresh: what an earlier attempt's
            // model spent does not count against this one.
            stats: sql`coalesce(${learnRuns.stats}, '{}'::jsonb) - 'tool_calls'`,
        })
        .where(
            and(
                eq(learnRuns.id, run.id),
                inArray(learnRuns.status, ["queued", "running"]),
            ),
        )
        .returning({ id: learnRuns.id });
    if (claimed.length === 0) return { skipped: "claimed" };

    try {
        const [transcript] = await db
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.id, run.transcriptionId));
        if (!transcript) {
            await setStatus(run.id, "cancelled");
            return { skipped: "gone" };
        }
        if (transcript.revision !== run.transcriptRevision) {
            await setStatus(run.id, "superseded");
            return { skipped: "superseded" };
        }
        const orgUserId = await sharingOrgUserId();
        if (!(await mayStillRun(run, orgUserId))) {
            await setStatus(run.id, "cancelled");
            return { skipped: "not allowed" };
        }
        const turns = readTranscriptTurns(transcript);
        if (!turns?.length) {
            await setStatus(run.id, "cancelled");
            return { skipped: "untimed" };
        }

        const shared = run.view === "org";
        const tools: LearnToolContext = {
            read: { kind: "recording", ownerUserId: run.userId, shared },
            budget: { remaining: TOOL_BUDGET },
            language: transcript.detectedLanguage,
        };
        const vocabulary = await vocabularyVisibleTo(run.scopeUserId, {
            sharedOnly: shared,
        });
        const relations: LearnRelationChoice[] =
            vocabulary.relationTypes.filter(
                (relation) => !relation.adoptedAsKey,
            );
        const entityTypes = newThingTypes(vocabulary);
        const frameBefore = await frameFor(run, {
            revision: transcript.revision,
            turns,
            language: transcript.detectedLanguage,
            provider: transcript.provider,
        });
        const labels = [...new Set(turns.map((turn) => turn.speaker))];
        const { chat, bridge, provider, baseUrl, model } = await chatFor(
            run,
            signal,
        );
        // Path 1: the bridge's CLI looks things up itself over MCP;
        // anything else takes the fallback, which looks up for it.
        const path = chooseLearnPath(
            { provider, baseUrl },
            { mcpUrl: env.LEARN_MCP_URL, bridgeUrl: env.LEARN_BRIDGE_URL },
        );
        const unnamedLabels = labels.filter(
            (label) => !frameBefore.answeredLabels.has(label),
        );
        // Who made the recording, unless a label already names them.
        const recorderId = frameBefore.recorderPersonId;
        const recorderName = recorderId
            ? frameBefore.people.get(recorderId)?.name
            : undefined;
        const recorder =
            recorderId &&
            recorderName &&
            ![...frameBefore.answeredLabels.values()].includes(recorderId)
                ? { personId: recorderId, name: recorderName }
                : null;
        reportProgress({ phase: "reading" });
        const pass =
            path === "bridge"
                ? await runBridgePass({
                      chat: bridge,
                      token: issueLearnRunToken(run.id),
                      turns,
                      language: transcript.detectedLanguage,
                      relations,
                      entityTypes,
                      unnamedLabels,
                      recorder,
                      signal,
                  })
                : await runFallbackPass({
                      chat,
                      lookup: {
                          findEntities: (query) => findEntities(tools, query),
                      },
                      lookupBudget: TOOL_BUDGET,
                      turns,
                      language: transcript.detectedLanguage,
                      relations,
                      entityTypes,
                      unnamedLabels,
                      recorder,
                      signal,
                  });
        reportProgress({ phase: "checking" });

        // Validated against the knowledge as it is now; written under the
        // recording and transcript locks, with the revision, the writer
        // rule and the run's own status checked once more, and validated
        // again when what the validation read moved meanwhile.
        const baseStats = {
            calls: pass.calls,
            lookups: pass.lookups,
            windows: pass.windows,
            repairs: pass.repairs,
            // A window whose answer was never the shape is lost: said,
            // not hidden behind a run that merely found nothing.
            ...(pass.failedWindows > 0
                ? { failed_windows: pass.failedWindows }
                : {}),
        };
        for (let fenceAttempt = 1; ; fenceAttempt++) {
            const lastAttempt = fenceAttempt >= FENCE_ATTEMPTS;
            const fence = await fenceOf(db, run, orgUserId);
            const frame = await frameFor(run, {
                revision: transcript.revision,
                turns,
                language: transcript.detectedLanguage,
                provider: transcript.provider,
            });
            const validated = validateLearnOutput(pass.output, frame);
            const items: ReviewCandidate[] = lastAttempt
                ? validated.items.map(
                      (item) =>
                          ({
                              ...item,
                              preTicked: false,
                          }) as ReviewCandidate,
                  )
                : validated.items;
            const stats = counts(items, {
                ...baseStats,
                ...(fenceAttempt > 1
                    ? { fence_retries: fenceAttempt - 1 }
                    : {}),
                ...Object.fromEntries(
                    Object.entries(validated.dropped).map(([reason, n]) => [
                        `dropped_${reason}`,
                        n ?? 0,
                    ]),
                ),
            });
            const outcome = await db.transaction(async (tx) => {
                await tx
                    .select({ id: recordings.id })
                    .from(recordings)
                    .where(eq(recordings.id, run.itemId))
                    .for("share");
                // Speaker answers are written under the transcript held
                // for update: holding it for share keeps them still.
                const [current] = await tx
                    .select({ revision: transcriptions.revision })
                    .from(transcriptions)
                    .where(eq(transcriptions.id, run.transcriptionId))
                    .for("share");
                const [still] = await tx
                    .select({ status: learnRuns.status })
                    .from(learnRuns)
                    .where(eq(learnRuns.id, run.id))
                    .for("update");
                if (!current || still?.status !== "running") {
                    return { status: "cancelled" as const, items: 0 };
                }
                const finish = (
                    status: "ready" | "finished" | "superseded" | "cancelled",
                ) =>
                    tx
                        .update(learnRuns)
                        .set({
                            status,
                            path,
                            provider,
                            model,
                            // Merged: the MCP route counts its tool
                            // calls on the same row.
                            stats: sql`coalesce(${learnRuns.stats}, '{}'::jsonb) || ${JSON.stringify(stats)}::jsonb`,
                            finishedAt: status === "ready" ? null : new Date(),
                            updatedAt: new Date(),
                        })
                        .where(eq(learnRuns.id, run.id));
                if (
                    validated.superseded ||
                    current.revision !== run.transcriptRevision
                ) {
                    await finish("superseded");
                    return { status: "superseded" as const, items: 0 };
                }
                if (!(await mayStillRun(run, orgUserId, tx))) {
                    await finish("cancelled");
                    return { status: "cancelled" as const, items: 0 };
                }
                if (
                    !lastAttempt &&
                    (await fenceOf(tx, run, orgUserId, { lock: true })) !==
                        fence
                ) {
                    return { status: "stale" as const, items: 0 };
                }
                if (items.length > 0) {
                    await tx.insert(learnReviewItems).values(
                        items.map((item) => ({
                            runId: run.id,
                            userId: run.scopeUserId,
                            kind: item.kind,
                            fingerprintHmac: learnFingerprintHmac(
                                item.fingerprint,
                            ),
                            payload: encryptJsonField(item.payload),
                            preTicked: item.preTicked,
                            dependsOnLabel:
                                "dependsOnLabel" in item
                                    ? (item.dependsOnLabel ?? null)
                                    : null,
                        })),
                    );
                }
                // An empty run says "nothing new found" and counts as
                // finished.
                const status =
                    items.length > 0
                        ? ("ready" as const)
                        : ("finished" as const);
                await finish(status);
                // Nothing to review: the transcript is read again now.
                const correcting =
                    status === "finished" &&
                    (await queueCorrectionPassInTx(tx, run));
                return { status, items: items.length, correcting };
            });
            if (outcome.status === "stale") continue;
            if ("correcting" in outcome && outcome.correcting) nudge();
            return { status: outcome.status, items: outcome.items };
        }
    } catch (caught) {
        // Final for Learn (lookups spent, no usable answer): no retry.
        const error = isFinalLearnError(caught)
            ? new AppError(
                  ErrorCode.AI_PROVIDER_API_ERROR,
                  caught instanceof Error ? caught.message : "Learn failed",
                  502,
              )
            : caught;
        // Retried by the queue when worth it: the run waits for it.
        const retrying = attempt < maxAttempts && isRetryableError(error);
        await setStatus(
            run.id,
            retrying ? "queued" : "failed",
            retrying
                ? {}
                : {
                      errorCode:
                          error instanceof AppError
                              ? error.code
                              : ErrorCode.INTERNAL_ERROR,
                      finishedAt: new Date(),
                  },
        );
        throw error;
    }
}
