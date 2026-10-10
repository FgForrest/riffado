import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { finishReview, requestedReviewSource } from "@/lib/learn/review";
import { refreshSummaryAfterCorrections } from "@/lib/learn/summary-refresh";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

/**
 * Finish the review: apply what is ticked, remember what is not, in one
 * transaction. `{versions}` are the item versions shown (409 if any
 * changed). A transcript changed since the run answers `superseded`.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access, actorUserId } = await authorizeLearn(request, id);
    // One version per item, and there are few.
    const read = await readBoundedJson(request, 64 * 1024);
    if (read.tooLarge) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Request too large", 413);
    }
    const body = (read.body ?? null) as {
        versions?: unknown;
    } | null;
    const versions =
        body?.versions && typeof body.versions === "object"
            ? Object.fromEntries(
                  Object.entries(
                      body.versions as Record<string, unknown>,
                  ).filter(
                      (entry): entry is [string, number] =>
                          typeof entry[1] === "number",
                  ),
              )
            : {};
    const finished = await finishReview(access, actorUserId, {
        versions,
        source: requestedReviewSource(request),
    });
    // What it applied, and what it left out that a waiting review had
    // ticked, may change what a summary read; a correction pass queued
    // refreshes it when it ends instead.
    if (finished.status === "finished" && !finished.correcting) {
        await refreshSummaryAfterCorrections({
            ownerUserId: access.ownerUserId,
            recordingId: id,
            view: access.view,
        });
    }
    return NextResponse.json(finished);
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
        { kinds: ALL_ITEM_KINDS },
    );
    assertMayChange(access, session.user.id);
    return { access, actorUserId: session.user.id };
}
