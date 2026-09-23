import { NextResponse } from "next/server";
import { getActiveJob } from "@/db/queries/async-jobs";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { assertOrgScopeWritable } from "@/lib/org/config";
import {
    recordingJobSubject,
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import {
    enqueueTranscriptionJob,
    TRANSCRIPTION_JOB_KIND,
} from "@/lib/transcription/transcription-job";

type IdContext = { params: Promise<{ id: string }> };

/**
 * Manual "Transcribe" / "Re-transcribe" endpoint. The durable job is shared
 * with upload and Plaud-sync auto-transcription, so concurrent triggers all
 * converge on the database's one-active-job constraint.
 *
 * `?view=org` transcribes the Organization view of a shared recording with
 * the caller's own provider; it never touches the owner's transcript.
 *
 * Request body (all optional):
 *   - `providerId`: use a specific configured provider instead of the
 *     user's default transcription provider. Looked up user-scoped.
 *   - `model`: override the provider's default model for this call.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);
    await requireRecordingView(session.user.id, id, view);
    if (view === "org") assertOrgScopeWritable();

    const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
    >;
    const providerId =
        typeof body.providerId === "string" ? body.providerId : undefined;
    const model = typeof body.model === "string" ? body.model : undefined;
    const attributionSource =
        view === "private" &&
        (body.attributionSource === "riffado" ||
            body.attributionSource === "plaud" ||
            body.attributionSource === "mixed")
            ? body.attributionSource
            : undefined;

    const { job, created } = await enqueueTranscriptionJob({
        userId: session.user.id,
        recordingId: id,
        providerId,
        model,
        attributionSource,
        force: true,
        trigger: "manual",
        view,
    });

    return NextResponse.json(
        { jobId: job.id, status: job.status, created },
        { status: 202 },
    );
});

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);
    await requireRecordingView(session.user.id, id, view);

    // On the Organization view the running job may be anyone's: whoever
    // clicked first. Everyone who can see the view can see that it runs.
    const active = await getActiveJob(
        TRANSCRIPTION_JOB_KIND,
        recordingJobSubject(id, view),
    );
    const activeJob =
        active && (view === "org" || active.userId === session.user.id)
            ? { jobId: active.id, status: active.status }
            : undefined;
    return NextResponse.json({ activeJob });
});
