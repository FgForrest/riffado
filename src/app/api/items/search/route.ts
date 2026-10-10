import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { searchItems } from "@/lib/search/item-search";

const MAX_QUERY = 200;

/**
 * Search the viewer's pile (`view=org`: the Organization's) for every word
 * of `q`, newest first, in what the browser does not hold: a mail's own
 * text and a recording's transcripts as stored. Bounded: when `complete`
 * is false, pass `continueBefore` back as `before` to search further.
 */
export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get("q") ?? "").trim();
    if (!query || query.length > MAX_QUERY) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `q must be 1 to ${MAX_QUERY} characters`,
            400,
        );
    }
    const before = searchParams.get("before");
    const result = await searchItems({
        viewerUserId: session.user.id,
        view: searchParams.get("view") === "org" ? "org" : "private",
        query,
        before: before && before.length <= 512 ? before : null,
    });
    return NextResponse.json(result);
});
