import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { learnRuns, transcriptions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { type LearnSource, startLearnRun } from "@/lib/learn/learn-job";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

function requestedSource(request: Request): LearnSource {
    return new URL(request.url).searchParams.get("source") === "plaud"
        ? "plaud"
        : "riffado";
}

/** Start Learn on one transcript (`?source=`), or join the run already open. */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access, actorUserId } = await authorizeLearn(request, id);
    const started = await startLearnRun({
        access,
        actorUserId,
        source: requestedSource(request),
        trigger: "manual",
    });
    return NextResponse.json(started, { status: 202 });
});

/** The runs on the recording in this view, newest first: status and counts. */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access } = await authorizeLearn(request, id);
    const runs = await db
        .select({
            id: learnRuns.id,
            source: transcriptions.source,
            status: learnRuns.status,
            trigger: learnRuns.trigger,
            stats: learnRuns.stats,
            createdAt: learnRuns.createdAt,
            finishedAt: learnRuns.finishedAt,
        })
        .from(learnRuns)
        .innerJoin(
            transcriptions,
            eq(transcriptions.id, learnRuns.transcriptionId),
        )
        .where(
            and(
                eq(learnRuns.itemId, access.recordingId),
                eq(learnRuns.view, access.view),
            ),
        )
        .orderBy(desc(learnRuns.createdAt))
        .limit(20);
    return NextResponse.json({ runs });
});

/**
 * Whoever may change the recording in the view asked for: the owner on
 * the private view; while it is shared, the organization account on the
 * Organization view (Learn's unconfirmed suggestions are theirs alone).
 */
async function authorizeLearn(request: Request, recordingId: string) {
    const session = await requireApiSession(request);
    const access = await requireRecordingView(
        session.user.id,
        recordingId,
        requestedRecordingView(request),
    );
    assertMayChange(access, session.user.id);
    return { access, actorUserId: session.user.id };
}
