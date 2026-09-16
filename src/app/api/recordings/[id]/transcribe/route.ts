import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { getActiveJob } from "@/db/queries/async-jobs";
import { recordings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
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
 * Request body (all optional):
 *   - `providerId`: use a specific configured provider instead of the
 *     user's default transcription provider. Looked up user-scoped.
 *   - `model`: override the provider's default model for this call.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    await requireOwnedRecording(id, session.user.id);

    const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
    >;
    const providerId =
        typeof body.providerId === "string" ? body.providerId : undefined;
    const model = typeof body.model === "string" ? body.model : undefined;

    const { job, created } = await enqueueTranscriptionJob({
        userId: session.user.id,
        recordingId: id,
        providerId,
        model,
        force: true,
        trigger: "manual",
    });

    return NextResponse.json(
        { jobId: job.id, status: job.status, created },
        { status: 202 },
    );
});

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    await requireOwnedRecording(id, session.user.id);

    const active = await getActiveJob(TRANSCRIPTION_JOB_KIND, id);
    const activeJob =
        active && active.userId === session.user.id
            ? { jobId: active.id, status: active.status }
            : undefined;
    return NextResponse.json({ activeJob });
});

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
