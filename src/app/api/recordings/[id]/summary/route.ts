import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { getActiveJob } from "@/db/queries/async-jobs";
import { aiEnhancements, recordings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { DEMO_SUMMARIES, isDemoRecordingId } from "@/lib/demo/fixtures";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { appErrorFromJobFailure } from "@/lib/jobs/retryable";
import { watchJob } from "@/lib/jobs/watch";
import type { MultiPassPhase } from "@/lib/summary/multi-pass";
import {
    encodeStreamEvent,
    type SummaryStreamEvent,
} from "@/lib/summary/progress-stream";
import { readStoredSummary } from "@/lib/summary/read-summary";
import {
    enqueueSummaryJob,
    SUMMARY_JOB_KIND,
    SUMMARY_TIMEOUT_MS,
} from "@/lib/summary/summary-job";

type IdContext = { params: Promise<{ id: string }> };

/**
 * How long a request will follow its job before letting go.
 *
 * Slightly past the handler's own ceiling, so in practice the job always
 * settles first and this only fires if something has gone very wrong. Letting
 * go costs the caller nothing: the job keeps running on the worker, and the
 * client already has its id.
 */
const WATCH_TIMEOUT_MS = SUMMARY_TIMEOUT_MS + 60_000;

/** Keep-alive cadence for the stream, well inside a typical proxy idle timeout. */
const KEEPALIVE_MS = 15_000;

/** Assert the recording exists and is the caller's, before queueing anything. */
async function requireOwnedRecording(
    recordingId: string,
    userId: string,
): Promise<void> {
    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
}

/** A stored progress snapshot, narrowed to what the wire format carries. */
function toStreamProgress(
    raw: Record<string, unknown>,
): { phase: MultiPassPhase; completed: number; total: number } | null {
    const phase = raw.phase;
    if (phase !== "passes" && phase !== "merging") return null;
    const completed = Number(raw.completed);
    const total = Number(raw.total);
    if (!Number.isFinite(completed) || !Number.isFinite(total)) return null;
    return { phase, completed, total };
}

/**
 * Queue a summary and report on it.
 *
 * Generation used to happen inside this handler. It now happens on the job
 * worker, because the request is the wrong place to own work that must not be
 * lost: a closed tab, a proxy timeout or -- the case that prompted this -- a
 * container upgrade would take the summary with it, most visibly on the
 * automatic path where nobody is watching to try again.
 *
 * Both response shapes are preserved. A caller that asks for the event stream
 * gets progress as it happens; every other caller gets the same JSON object
 * it always did, because this handler waits for the job on its behalf.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const userId = session.user.id;

    const { id } = await (context as IdContext).params;
    const body = await request.json().catch(() => ({}));
    const presetId = (body.preset as string) || undefined;

    // Checked here rather than left to the handler: a recording that does not
    // exist should be a 404 on the spot, not a job that is queued, claimed and
    // then fails a second later with nobody having learned anything sooner.
    await requireOwnedRecording(id, userId);

    const { job } = await enqueueSummaryJob({
        userId,
        recordingId: id,
        presetId,
        trigger: "manual",
    });

    // The JSON path stays the default. Only a caller that asks for the event
    // stream gets one, so the API tests and any client that predates
    // streaming keep the response they expect.
    const accept = request.headers.get("accept") ?? "";
    if (!accept.includes("text/event-stream")) {
        const { row, reason } = await watchJob(job.id, userId, {
            timeoutMs: WATCH_TIMEOUT_MS,
        });

        if (reason === "timeout" || !row) {
            // Not a failure. The work is still queued or running, and the
            // caller can follow it at /api/jobs/{id}.
            return NextResponse.json(
                { jobId: job.id, status: row?.status ?? "pending" },
                { status: 202 },
            );
        }
        if (row.status === "failed") {
            throw appErrorFromJobFailure(row.errorCode, row.lastError);
        }
        const stored = await readStoredSummary(userId, id);
        if (!stored) {
            throw new AppError(
                ErrorCode.INTERNAL_ERROR,
                "The summary job reported success but no summary was stored",
                500,
            );
        }
        const result = (row.result ?? {}) as Record<string, unknown>;
        return NextResponse.json({
            summary: stored.summary,
            keyPoints: stored.keyPoints,
            actionItems: stored.actionItems,
            provider: stored.provider ?? result.provider,
            model: stored.model ?? result.model,
            promptId: result.promptId,
            promptFallback: result.promptFallback === true,
            multiPass: stored.multiPass,
        });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            let closed = false;
            const write = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    // The client hung up. Generation deliberately continues:
                    // it belongs to the job now, not to this request, and the
                    // summary is persisted either way.
                    closed = true;
                }
            };
            const send = (event: SummaryStreamEvent) =>
                write(encodeStreamEvent(event));

            // First, so a client whose connection dies a moment later still
            // knows which job to go back to.
            send({ type: "queued", jobId: job.id });

            let lastKeepalive = Date.now();
            try {
                const { row, reason } = await watchJob(job.id, userId, {
                    timeoutMs: WATCH_TIMEOUT_MS,
                    onProgress: (progress) => {
                        const narrowed = toStreamProgress(progress);
                        if (narrowed) send({ type: "progress", ...narrowed });
                    },
                    onPoll: () => {
                        // A comment frame: it keeps proxies from closing an
                        // idle connection during a pass that reports nothing
                        // for half a minute. The client's parser ignores
                        // anything that is not a `data:` line.
                        if (Date.now() - lastKeepalive >= KEEPALIVE_MS) {
                            lastKeepalive = Date.now();
                            write(": keep-alive\n\n");
                        }
                    },
                });

                if (!row || reason === "timeout") {
                    // Deliberately silent. Nothing failed -- the job is still
                    // running, and an error event would say otherwise. The
                    // client was handed the job id in the `queued` event and
                    // treats an unsettled stream as its cue to go and poll,
                    // which is the same path a dropped connection takes.
                } else if (row.status === "failed") {
                    const mapped = appErrorFromJobFailure(
                        row.errorCode,
                        row.lastError,
                    );
                    send({
                        type: "error",
                        error: mapped.message,
                        code: mapped.code,
                    });
                } else {
                    const stored = await readStoredSummary(userId, id);
                    const result = (row.result ?? {}) as Record<
                        string,
                        unknown
                    >;
                    if (stored) {
                        send({
                            type: "result",
                            result: {
                                summary: stored.summary ?? "",
                                keyPoints: stored.keyPoints,
                                actionItems: stored.actionItems,
                                provider:
                                    stored.provider ??
                                    (result.provider as string | undefined),
                                model:
                                    stored.model ??
                                    (result.model as string | undefined),
                                promptId: result.promptId as string | undefined,
                                promptFallback: result.promptFallback === true,
                                multiPass: stored.multiPass,
                            },
                        });
                    } else {
                        send({
                            type: "error",
                            error: "The summary job reported success but no summary was stored",
                            code: ErrorCode.INTERNAL_ERROR,
                        });
                    }
                }
            } catch (error) {
                // Status is already 200 by the time anything can fail here, so
                // the failure has to travel as an event.
                const mapped = appErrorFromJobFailure(
                    null,
                    error instanceof Error ? error.message : undefined,
                );
                send({
                    type: "error",
                    error: mapped.message,
                    code: mapped.code,
                });
            } finally {
                try {
                    controller.close();
                } catch {
                    // Already closed by a client disconnect.
                }
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            // `no-transform` and `X-Accel-Buffering` stop an intermediate
            // proxy from buffering the stream into one chunk at the end,
            // which would deliver every progress event at once, after the
            // work they describe had already finished.
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
});

// GET - Fetch existing summary
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);

    const { id } = await (context as IdContext).params;

    // Dev-only short-circuit for the `/dev/demo-dashboard` screenshot
    // route. Two gates -- `NODE_ENV !== production` AND a `demo-` id
    // prefix -- so this branch is literally unreachable in production
    // builds even if a caller invents a `demo-*` id. Never touches the
    // DB, never decrypts, never logs PII. See `src/lib/demo/fixtures.ts`.
    if (process.env.NODE_ENV !== "production" && isDemoRecordingId(id)) {
        const fixture = DEMO_SUMMARIES.get(id);
        if (!fixture) {
            return NextResponse.json({ summary: null });
        }
        return NextResponse.json({
            summary: fixture.summary,
            keyPoints: fixture.keyPoints,
            actionItems: fixture.actionItems,
            provider: fixture.provider,
            model: fixture.model,
        });
    }

    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);

    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    // Reported alongside the summary so a page opened while a summary is
    // being generated -- in another tab, by an automatic run, or by a worker
    // that picked the job back up after a restart -- can show that and
    // reattach, instead of an empty panel that gives no sign anything is
    // happening.
    const active = await getActiveJob(SUMMARY_JOB_KIND, id);
    const activeJob =
        active && active.userId === session.user.id
            ? {
                  jobId: active.id,
                  status: active.status,
                  progress: active.progress ?? null,
              }
            : undefined;

    const stored = await readStoredSummary(session.user.id, id);

    if (!stored) {
        return NextResponse.json({ summary: null, activeJob });
    }

    return NextResponse.json({
        summary: stored.summary,
        keyPoints: stored.keyPoints,
        actionItems: stored.actionItems,
        provider: stored.provider,
        model: stored.model,
        multiPass: stored.multiPass,
        createdAt: stored.createdAt,
        activeJob,
    });
});

// DELETE - Remove summary
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);

    const { id } = await (context as IdContext).params;

    await db.transaction(async (tx) => {
        const deleted = await tx
            .delete(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.recordingId, id),
                    eq(aiEnhancements.userId, session.user.id),
                ),
            )
            .returning({ id: aiEnhancements.id });

        if (deleted.length > 0) {
            await tx
                .update(recordings)
                .set({ updatedAt: new Date() })
                .where(
                    and(
                        eq(recordings.id, id),
                        eq(recordings.userId, session.user.id),
                        isNull(recordings.deletedAt),
                    ),
                );
        }
    });

    return NextResponse.json({ success: true });
});
