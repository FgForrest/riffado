/**
 * `GET /api/jobs/[id]` -- follow a durable job.
 *
 * The resume path for anything that watches a job over a connection that can
 * break. A summary's event stream ends when the laptop closes, the proxy
 * times out, or the container is upgraded; the job does not, so the client
 * polls here to find out how it went rather than reporting an interruption
 * for work that is still running.
 */

import { NextResponse } from "next/server";
import type { AsyncJobRow } from "@/db/queries/async-jobs";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { getJobVisibleTo } from "@/lib/sharing/jobs";

type IdContext = { params: Promise<{ id: string }> };

/**
 * The public view of a job.
 *
 * An allowlist, not a redaction. `claimToken` is an internal lease and
 * `payload` is whatever the handler was given -- neither is any of a
 * client's business, and building the response from named fields means a
 * column added later is private until somebody decides otherwise.
 */
function toPublicJob(job: AsyncJobRow, viewerId: string) {
    return {
        id: job.id,
        kind: job.kind,
        subjectId: job.subjectId,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        progress: job.progress ?? null,
        // Provenance only, by the rule on `asyncJobs` in the schema.
        result: job.result ?? null,
        // A provider error can quote a base URL or key hint of whoever ran
        // the job; someone following another member's Organization job gets
        // the code, not the text.
        error: job.userId === viewerId ? job.lastError : null,
        errorCode: job.errorCode,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
    };
}

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;

    // Scoped to the caller, so a job id -- which travels to the browser and
    // may end up in a log or a bug report -- grants nothing on its own. An
    // Organization job is the caller's to follow while they can see the view.
    const job = await getJobVisibleTo(id, session.user.id);
    if (!job) {
        throw new AppError(ErrorCode.NOT_FOUND, "Job not found", 404);
    }

    return NextResponse.json(toPublicJob(job, session.user.id));
});
