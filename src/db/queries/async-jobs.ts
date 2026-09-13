/**
 * Queue operations for `async_jobs`.
 *
 * Every statement that a worker uses to change a job it is running is scoped
 * to the claim token it holds, so a job reclaimed out from under a stalled
 * worker cannot then be corrupted by that worker's late write -- it simply
 * matches zero rows. See `asyncJobs.claimToken` in the schema.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { asyncJobStatusEnum, asyncJobs } from "@/db/schema";

/**
 * `async_job_status`, named from the schema so a rename cannot leave a stale
 * literal behind in the raw SQL below.
 */
const STATUS_TYPE = sql.identifier(asyncJobStatusEnum.enumName);

export type AsyncJobStatus = "pending" | "processing" | "completed" | "failed";

export interface AsyncJobRow {
    id: string;
    userId: string;
    kind: string;
    subjectId: string | null;
    priority: number;
    payload: Record<string, unknown>;
    status: AsyncJobStatus;
    attempts: number;
    maxAttempts: number;
    nextAttemptAt: Date;
    claimToken: string | null;
    progress: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    lastError: string | null;
    errorCode: string | null;
    heartbeatAt: Date | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    updatedAt: Date;
}

/** A claimed job as the worker sees it: the row plus the token that owns it. */
export interface ClaimedAsyncJob {
    id: string;
    userId: string;
    kind: string;
    subjectId: string | null;
    payload: Record<string, unknown>;
    attempts: number;
    maxAttempts: number;
    claimToken: string;
}

/** Postgres SQLSTATE for unique_violation. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;
    return code === PG_UNIQUE_VIOLATION || causeCode === PG_UNIQUE_VIOLATION;
}

/**
 * `db.execute` returns an array on some drivers and `{ rows }` on others.
 * Normalising here keeps every call site below from repeating the check.
 */
function rowsOf<T>(result: unknown): T[] {
    if (Array.isArray(result)) return result as T[];
    return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

export interface EnqueueJobInput {
    userId: string;
    kind: string;
    /** Domain object this job acts on. Enforces one live job per subject. */
    subjectId?: string | null;
    /** Higher runs first. */
    priority?: number;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
    /** Delay before the job first becomes claimable. */
    delayMs?: number;
}

export interface EnqueueJobResult {
    job: AsyncJobRow;
    /**
     * False when an equivalent job was already queued or running and this
     * call returned that one instead. Callers that report "started" to a user
     * want to know the difference; callers that just want the work to happen
     * do not.
     */
    created: boolean;
}

/**
 * Queue a job, or hand back the one already queued for the same subject.
 *
 * The real "one live job per (kind, subject)" guard is the partial unique
 * index, not a check here: two requests racing the same check would both pass
 * it. When the insert loses that race this returns the winner, so a
 * double-clicked button and a single click are indistinguishable to the
 * caller instead of one of them erroring.
 */
export async function enqueueJob(
    input: EnqueueJobInput,
): Promise<EnqueueJobResult> {
    const values = {
        userId: input.userId,
        kind: input.kind,
        subjectId: input.subjectId ?? null,
        priority: input.priority ?? 0,
        payload: input.payload ?? {},
        maxAttempts: input.maxAttempts ?? 3,
        nextAttemptAt: new Date(Date.now() + (input.delayMs ?? 0)),
    };

    try {
        const [row] = await db.insert(asyncJobs).values(values).returning();
        return { job: row as AsyncJobRow, created: true };
    } catch (error) {
        if (!isUniqueViolation(error) || !input.subjectId) throw error;
        const active = await getActiveJob(input.kind, input.subjectId);
        if (active) return { job: active, created: false };
        // The conflicting job would have had to finish between the failed
        // insert and this read. Vanishingly unlikely, and not worth
        // swallowing into a confusing retry if something else is wrong.
        throw error;
    }
}

/** The pending-or-processing job for a subject, if there is one. */
export async function getActiveJob(
    kind: string,
    subjectId: string,
): Promise<AsyncJobRow | null> {
    const [row] = await db
        .select()
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.kind, kind),
                eq(asyncJobs.subjectId, subjectId),
                sql`${asyncJobs.status} in ('pending', 'processing')`,
            ),
        )
        .limit(1);
    return (row as AsyncJobRow) ?? null;
}

/**
 * Most recent job for a subject regardless of status, scoped to its owner.
 *
 * Used when a client reattaches: a page reloaded after the work finished
 * needs to learn that it finished (and how), not just that nothing is
 * running.
 */
export async function getLatestJobForSubject(
    kind: string,
    subjectId: string,
    userId: string,
): Promise<AsyncJobRow | null> {
    const [row] = await db
        .select()
        .from(asyncJobs)
        .where(
            and(
                eq(asyncJobs.kind, kind),
                eq(asyncJobs.subjectId, subjectId),
                eq(asyncJobs.userId, userId),
            ),
        )
        .orderBy(desc(asyncJobs.createdAt))
        .limit(1);
    return (row as AsyncJobRow) ?? null;
}

/** One job by id, scoped to its owner so an id alone grants nothing. */
export async function getJobForUser(
    jobId: string,
    userId: string,
): Promise<AsyncJobRow | null> {
    const [row] = await db
        .select()
        .from(asyncJobs)
        .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.userId, userId)))
        .limit(1);
    return (row as AsyncJobRow) ?? null;
}

/**
 * Atomically claim up to `limit` due jobs of one kind.
 *
 * A single `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, so
 * two worker processes ticking at the same moment can never both take the
 * same job. Claiming per kind (rather than taking whatever is oldest) is
 * what lets each kind carry its own concurrency: the summary handler runs
 * one job at a time because three parallel passes already saturate the agent
 * bridge, while a cheaper kind can run several.
 *
 * `heartbeat_at` is seeded at claim time so a job that dies before its
 * handler reports anything is still reclaimable on the normal schedule.
 *
 * `attempts` is incremented HERE, at claim time, not when an attempt fails.
 * That is the difference between bounding retries and bounding only the
 * failures a worker survived long enough to report: a job that kills its
 * process -- an OOM on a huge transcript, say -- never reaches any failure
 * path, so an increment on failure would let it be reclaimed and crash the
 * container again forever. Counting the attempt when it starts means such a
 * job runs `max_attempts` times and is then buried.
 */
export async function claimDueJobs(
    kind: string,
    limit: number,
): Promise<ClaimedAsyncJob[]> {
    if (limit <= 0) return [];
    const result = await db.execute(sql`
        update ${asyncJobs}
        set status = 'processing',
            started_at = now(),
            heartbeat_at = now(),
            updated_at = now(),
            attempts = attempts + 1,
            claim_token = gen_random_uuid()::text
        where id in (
            select id from ${asyncJobs}
            where status = 'pending'
              and kind = ${kind}
              and next_attempt_at <= now()
            order by priority desc, next_attempt_at asc, created_at asc
            limit ${limit}
            for update skip locked
        )
        returning id, user_id, kind, subject_id, payload, attempts, max_attempts, claim_token
    `);

    return rowsOf<{
        id: string;
        user_id: string;
        kind: string;
        subject_id: string | null;
        payload: Record<string, unknown>;
        attempts: number;
        max_attempts: number;
        claim_token: string;
    }>(result).map((r) => ({
        id: r.id,
        userId: r.user_id,
        kind: r.kind,
        subjectId: r.subject_id,
        payload: r.payload ?? {},
        attempts: r.attempts,
        maxAttempts: r.max_attempts,
        claimToken: r.claim_token,
    }));
}

/**
 * Record that a claimed job is alive, optionally with a progress snapshot.
 *
 * Returns false when the claim no longer matches, which is the signal the
 * worker uses to abandon work it no longer owns: the job was reclaimed while
 * this process was (from the queue's point of view) unresponsive, and
 * continuing would mean two workers running the same job.
 */
export async function heartbeatJob(
    jobId: string,
    claimToken: string,
    progress?: Record<string, unknown> | null,
): Promise<boolean> {
    const result = await db
        .update(asyncJobs)
        .set({
            heartbeatAt: new Date(),
            updatedAt: new Date(),
            ...(progress === undefined ? {} : { progress }),
        })
        .where(
            and(
                eq(asyncJobs.id, jobId),
                eq(asyncJobs.claimToken, claimToken),
                eq(asyncJobs.status, "processing"),
            ),
        )
        .returning({ id: asyncJobs.id });
    return result.length > 0;
}

/**
 * Mark a job done. Scoped to the claim, so a superseded worker finishing late
 * cannot overwrite whatever the current owner has since done with the job.
 */
export async function completeJob(input: {
    jobId: string;
    claimToken: string;
    result?: Record<string, unknown> | null;
}): Promise<boolean> {
    const now = new Date();
    const rows = await db
        .update(asyncJobs)
        .set({
            status: "completed",
            result: input.result ?? null,
            lastError: null,
            errorCode: null,
            completedAt: now,
            heartbeatAt: now,
            updatedAt: now,
        })
        .where(
            and(
                eq(asyncJobs.id, input.jobId),
                eq(asyncJobs.claimToken, input.claimToken),
            ),
        )
        .returning({ id: asyncJobs.id });
    return rows.length > 0;
}

export interface FailJobOutcome {
    status: AsyncJobStatus;
    attempts: number;
}

/**
 * Record a failed attempt, requeueing it with backoff or burying it.
 *
 * A job is buried when the error is not worth retrying (a deleted recording,
 * an unconfigured provider -- nothing about waiting makes those succeed) or
 * when it has used its attempts. Otherwise it goes back to `pending` with
 * `next_attempt_at` pushed out by `delayMs`, which is where exponential
 * backoff actually takes effect.
 *
 * The claim token is deliberately kept on a buried job and cleared on a
 * requeued one: clearing it is what lets the next claim take the job, so
 * keeping it on a terminal row means a late write from the failed attempt
 * still matches nothing.
 *
 * Returns null if the claim no longer matches -- there is nothing to record
 * against a job this worker no longer owns.
 */
export async function failJobAttempt(input: {
    jobId: string;
    claimToken: string;
    message: string;
    code?: string | null;
    retryable: boolean;
    delayMs: number;
}): Promise<FailJobOutcome | null> {
    // One expression, evaluated once per column, rather than five copies of
    // the same condition drifting apart later.
    const buried = sql`(${!input.retryable}::boolean or attempts >= max_attempts)`;
    // The cast on `status` is load-bearing: a `case` over bare literals
    // resolves to `text`, which Postgres will not assign to an enum column.
    const result = await db.execute(sql`
        update ${asyncJobs}
        set last_error = ${input.message},
            error_code = ${input.code ?? null},
            updated_at = now(),
            status = (case when ${buried} then 'failed' else 'pending' end)::${STATUS_TYPE},
            claim_token = case when ${buried} then claim_token else null end,
            started_at = case when ${buried} then started_at else null end,
            completed_at = case when ${buried} then now() else null end,
            next_attempt_at = case
                when ${buried} then next_attempt_at
                else now() + make_interval(secs => ${input.delayMs / 1000}::double precision)
            end
        where id = ${input.jobId} and claim_token = ${input.claimToken}
        returning status, attempts
    `);
    return rowsOf<FailJobOutcome>(result)[0] ?? null;
}

/**
 * Reclaim jobs whose worker stopped heartbeating.
 *
 * This is the whole point of the table. A container upgrade, an OOM kill or a
 * crash leaves a row stuck in `processing` with nothing in the process that
 * owned it left to notice -- no in-process timer survives its own process. A
 * missed heartbeat is the only evidence available, and unlike elapsed runtime
 * it does not force a choice between reclaiming long-but-healthy jobs early
 * and leaving genuinely dead ones for hours.
 *
 * A reclaimed job keeps its `attempts` count, so a job that reliably kills
 * the process (rather than merely being interrupted by an unlucky restart)
 * still exhausts its attempts and is buried instead of restarting the
 * process forever.
 */
export async function reclaimStaleJobs(staleMs: number): Promise<number> {
    const result = await db.execute(sql`
        update ${asyncJobs}
        set status = 'pending',
            claim_token = null,
            started_at = null,
            next_attempt_at = now(),
            last_error = coalesce(last_error, 'Worker stopped responding; job reclaimed'),
            updated_at = now()
        where status = 'processing'
          and attempts < max_attempts
          and coalesce(heartbeat_at, started_at) < now() - make_interval(secs => ${staleMs / 1000}::double precision)
        returning id
    `);
    return rowsOf<{ id: string }>(result).length;
}

/**
 * Bury jobs that were reclaimed once too often.
 *
 * Separate from `reclaimStaleJobs` because the two say different things: one
 * is "try again", this is "this job has now killed as many workers as it is
 * allowed to". Without it, a job whose handler reliably crashes the process
 * would be reclaimed forever, taking the container with it each time.
 */
export async function buryExhaustedStaleJobs(staleMs: number): Promise<number> {
    const result = await db.execute(sql`
        update ${asyncJobs}
        set status = 'failed',
            completed_at = now(),
            updated_at = now(),
            last_error = coalesce(last_error, 'Worker stopped responding and no attempts remain')
        where status = 'processing'
          and attempts >= max_attempts
          and coalesce(heartbeat_at, started_at) < now() - make_interval(secs => ${staleMs / 1000}::double precision)
        returning id
    `);
    return rowsOf<{ id: string }>(result).length;
}

/**
 * Hand claimed jobs straight back to the queue, claim-scoped.
 *
 * Called on a clean shutdown. Unlike `reclaimStaleJobs`, this REFUNDS the
 * attempt: the job did not fail and did not kill anything, it was interrupted
 * by a deploy, and charging it for that would mean three upgrades in a row
 * could bury work that never once misbehaved. The distinction is only safe
 * because reaching this code proves the process is shutting down in an
 * orderly way -- a job that crashes its host never gets here, and takes the
 * non-refunding `reclaimStaleJobs` path instead.
 */
export async function releaseClaimedJobs(
    claims: { jobId: string; claimToken: string }[],
): Promise<number> {
    if (claims.length === 0) return 0;
    const pairs = sql.join(
        claims.map((c) => sql`(${c.jobId}, ${c.claimToken})`),
        sql`, `,
    );
    const result = await db.execute(sql`
        update ${asyncJobs}
        set status = 'pending',
            claim_token = null,
            started_at = null,
            next_attempt_at = now(),
            attempts = greatest(attempts - 1, 0),
            updated_at = now()
        where (id, claim_token) in (${pairs})
          and status = 'processing'
        returning id
    `);
    return rowsOf<{ id: string }>(result).length;
}

/**
 * Delete finished rows past their retention window.
 *
 * Jobs are kept for a while after they settle so a client that reconnects can
 * still be told how the work went, but they are bookkeeping, not history --
 * nothing reads them once that window has passed.
 */
export async function pruneFinishedJobs(
    olderThanMs: number,
    limit: number,
): Promise<number> {
    const result = await db.execute(sql`
        delete from ${asyncJobs}
        where id in (
            select id from ${asyncJobs}
            where status in ('completed', 'failed')
              and completed_at is not null
              and completed_at < now() - make_interval(secs => ${olderThanMs / 1000}::double precision)
            order by completed_at asc
            limit ${limit}
        )
        returning id
    `);
    return rowsOf<{ id: string }>(result).length;
}

/**
 * Jobs left `pending` by a process that enqueued them and then died before
 * running them. They need nothing done to them -- `claimDueJobs` picks them
 * up on its own -- but counting them is how the worker log can say whether a
 * restart actually left work behind.
 */
export async function countPendingJobs(kind?: string): Promise<number> {
    const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(asyncJobs)
        .where(
            kind
                ? and(eq(asyncJobs.status, "pending"), eq(asyncJobs.kind, kind))
                : eq(asyncJobs.status, "pending"),
        );
    return Number(rows[0]?.count ?? 0);
}

/**
 * Jobs for a user, newest first. Powers any "what is running" view and makes
 * a stuck queue diagnosable without database access.
 */
export async function listJobsForUser(
    userId: string,
    opts: { kind?: string; limit?: number; activeOnly?: boolean } = {},
): Promise<AsyncJobRow[]> {
    const filters = [eq(asyncJobs.userId, userId)];
    if (opts.kind) filters.push(eq(asyncJobs.kind, opts.kind));
    if (opts.activeOnly) {
        filters.push(sql`${asyncJobs.status} in ('pending', 'processing')`);
    }
    const rows = await db
        .select()
        .from(asyncJobs)
        .where(and(...filters))
        .orderBy(desc(asyncJobs.createdAt))
        .limit(opts.limit ?? 20);
    return rows as AsyncJobRow[];
}
