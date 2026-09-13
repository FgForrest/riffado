import { NextResponse } from "next/server";
import {
    countReapCandidates,
    type RetentionPolicy,
    retentionCutoff,
} from "@/db/queries/retention";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";

/**
 * How many recordings the given retention policy would reap right now.
 *
 * Takes the policy from the query string rather than from the stored
 * settings on purpose: the point is to answer "what happens if I turn
 * this on" *before* it is turned on. Enabling retention should not be the
 * way you discover how much it is about to delete.
 *
 * Read-only. It deletes nothing and saves nothing.
 */
export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const { searchParams } = new URL(request.url);

    const days = Number(searchParams.get("days"));
    if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "days must be an integer between 1 and 365",
            400,
        );
    }

    const policy: RetentionPolicy = {
        userId: session.user.id,
        retentionDays: days,
        audio: searchParams.get("audio") === "true",
        transcript: searchParams.get("transcript") === "true",
        summary: searchParams.get("summary") === "true",
    };

    if (!policy.audio && !policy.transcript && !policy.summary) {
        return NextResponse.json({ count: 0, capped: false });
    }

    const count = await countReapCandidates(
        policy,
        retentionCutoff(policy.retentionDays),
    );

    // `countReapCandidates` stops at 1000 so a huge library can't turn a
    // settings-panel hint into an expensive scan. Say so rather than
    // reporting a flat 1000 as if it were the true figure.
    return NextResponse.json({ count, capped: count >= 1000 });
});
