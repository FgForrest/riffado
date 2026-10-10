import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decideReviewItem, requestedReviewSource } from "@/lib/learn/review";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

type ItemContext = { params: Promise<{ id: string; itemId: string }> };

/** A draft is a decision and a small choice; nothing near this. */
const MAX_DRAFT_BYTES = 16 * 1024;

/**
 * Keep a draft decision on one review item: `{decision, version, choice?}`,
 * `decision` one of `accepted`, `rejected` or null (the default again).
 * 409 when the item changed since the version given.
 */
export const PATCH = apiHandler<ItemContext>(async (request, context) => {
    const { id, itemId } = await (context as ItemContext).params;
    const { access } = await authorizeLearn(request, id);
    const read = await readBoundedJson(request, MAX_DRAFT_BYTES);
    if (read.tooLarge) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Request too large", 413);
    }
    const body = (read.body ?? null) as {
        decision?: unknown;
        version?: unknown;
        choice?: unknown;
    } | null;
    const decision = body?.decision;
    if (
        !body ||
        !(
            decision === "accepted" ||
            decision === "rejected" ||
            decision === null
        ) ||
        typeof body.version !== "number" ||
        !Number.isInteger(body.version)
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "decision and version are required",
            400,
        );
    }
    return NextResponse.json(
        await decideReviewItem(
            access,
            itemId,
            {
                decision,
                version: body.version,
                choice: body.choice,
            },
            requestedReviewSource(request),
        ),
    );
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
