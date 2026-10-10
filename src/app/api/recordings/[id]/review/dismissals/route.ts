import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { ALL_ITEM_KINDS } from "@/lib/content/item-kinds";
import { apiHandler } from "@/lib/errors";
import { forgetDismissals } from "@/lib/learn/review";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

/**
 * Forget what was rejected in Learn's reviews of this recording, in this
 * view, so Re-learn may propose it again.
 */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const { id } = await (context as IdContext).params;
    const session = await requireApiSession(request);
    const access = await requireRecordingView(
        session.user.id,
        id,
        requestedRecordingView(request),
        { kinds: ALL_ITEM_KINDS },
    );
    assertMayChange(access, session.user.id);
    return NextResponse.json({ forgotten: await forgetDismissals(access) });
});
