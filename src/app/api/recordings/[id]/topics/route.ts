import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { getActiveJob } from "@/db/queries/async-jobs";
import { transcriptions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { appErrorFromJobFailure } from "@/lib/jobs/retryable";
import { watchJob } from "@/lib/jobs/watch";
import {
    recordingJobSubject,
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { getJobVisibleTo } from "@/lib/sharing/jobs";
import type { TopicSource } from "@/lib/topics/generate-topics";
import { readTranscriptTopics } from "@/lib/topics/stored-topics";
import { enqueueTopicsJob, TOPICS_JOB_KIND } from "@/lib/topics/topics-job";

type IdContext = { params: Promise<{ id: string }> };

/**
 * How long a request follows its job. Well short of the job's own ceiling:
 * past it the client gets the job id and follows `/api/jobs/{id}` itself,
 * which costs it nothing and keeps a request from hanging for minutes.
 */
const WATCH_TIMEOUT_MS = 120_000;

function requestedTopicSource(request: Request): TopicSource {
    return new URL(request.url).searchParams.get("source") === "plaud"
        ? "plaud"
        : "riffado";
}

/**
 * Topics are written onto the transcript row, and on the Organization view
 * that row can be the owner's, read through until someone edits the view.
 */
function assertPrivateView(request: Request): void {
    if (requestedRecordingView(request) === "org") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Topics can be detected only on your own view of a recording",
            400,
        );
    }
}

async function readTopics(
    userId: string,
    recordingId: string,
    source: TopicSource,
) {
    const [row] = await db
        .select({ topics: transcriptions.topics })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, source),
            ),
        )
        .limit(1);
    return readTranscriptTopics(row);
}

/** The stored topics of one transcript, and the job detecting them, if any. */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const userId = session.user.id;
    const { id } = await (context as IdContext).params;
    assertPrivateView(request);
    await requireRecordingView(userId, id, "private");
    const source = requestedTopicSource(request);

    const job = await getActiveJob(
        TOPICS_JOB_KIND,
        recordingJobSubject(id, "private"),
    );
    return NextResponse.json({
        topics: await readTopics(userId, id, source),
        jobId: job && job.payload.source === source ? job.id : null,
    });
});

/**
 * Detect the topics of one transcript, replacing any it has.
 *
 * Answers with the topics once the job finishes, or with 202 and the job id
 * when it takes longer than the request is willing to wait.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const userId = session.user.id;
    const { id } = await (context as IdContext).params;
    assertPrivateView(request);
    await requireRecordingView(userId, id, "private");
    const source = requestedTopicSource(request);

    const { job } = await enqueueTopicsJob({
        userId,
        recordingId: id,
        source,
        trigger: "manual",
    });
    // The queue keeps one topics job per recording; an already-running job
    // for the other transcript must not be reported as this one's.
    if (job.payload.source !== source) {
        throw new AppError(
            ErrorCode.CONFLICT,
            "Topics are being detected on this recording's other transcript. Try again when that finishes.",
            409,
        );
    }

    const { row, reason } = await watchJob(job.id, userId, {
        timeoutMs: WATCH_TIMEOUT_MS,
        readJob: getJobVisibleTo,
    });
    if (reason === "timeout" || !row) {
        return NextResponse.json(
            { jobId: job.id, status: row?.status ?? "pending" },
            { status: 202 },
        );
    }
    if (row.status === "failed") {
        throw appErrorFromJobFailure(row.errorCode, row.lastError);
    }
    return NextResponse.json({
        topics: (await readTopics(userId, id, source)) ?? [],
    });
});
