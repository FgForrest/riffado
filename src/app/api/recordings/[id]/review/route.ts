import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { apiHandler } from "@/lib/errors";
import { isLearnAvailableFor } from "@/lib/knowledge/availability";
import { loadReview, requestedReviewSource } from "@/lib/learn/review";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

/**
 * The latest Learn run in this view and what it proposed: open when ready,
 * with each item's outcome once finished, and why it failed when it did.
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const { access, actorUserId } = await authorizeLearn(request, id);
    return NextResponse.json({
        ...(await loadReview(access, requestedReviewSource(request))),
        // Whether this actor can run Learn at all (self-hosted, with a chat
        // provider): the page offers it only then.
        available: await isLearnAvailableFor(actorUserId),
    });
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
