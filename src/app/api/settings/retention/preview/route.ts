import { NextResponse } from "next/server";
import {
    countReapCandidates,
    type RetentionPolicy,
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

    const readDays = (name: string): number | null => {
        const raw = searchParams.get(name);
        if (raw === null || raw === "") return null;
        const days = Number(raw);
        if (!Number.isInteger(days) || days < 1 || days > 365) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                `${name} must be an integer between 1 and 365`,
                400,
            );
        }
        return days;
    };

    const policy: RetentionPolicy = {
        userId: session.user.id,
        remoteOriginalDays: readDays("remoteOriginalDays"),
        audioDays: readDays("localAudioDays"),
        transcriptDays: readDays("localTranscriptDays"),
        summaryDays: readDays("localSummaryDays"),
    };

    if (
        policy.remoteOriginalDays === null &&
        policy.audioDays === null &&
        policy.transcriptDays === null &&
        policy.summaryDays === null
    ) {
        return NextResponse.json({ count: 0 });
    }

    const count = await countReapCandidates(policy);

    return NextResponse.json({ count });
});
