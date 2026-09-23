import { NextResponse } from "next/server";
import {
    countReapCandidates,
    loadOrgRetentionContext,
    type RetentionPolicy,
} from "@/db/queries/retention";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { getOrgUserId, isOrgAccount } from "@/lib/org/config";

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

    // The organization account's policy only ever removes the Organization
    // view's transcripts and summaries; everyone else's audio period is
    // held back by the Organization while a recording is shared. The preview
    // counts under the same rules the sweep deletes by.
    const isOrg = await isOrgAccount(session.user.id);
    const policy: RetentionPolicy = {
        userId: session.user.id,
        remoteOriginalDays: isOrg ? null : readDays("remoteOriginalDays"),
        audioDays: isOrg ? null : readDays("localAudioDays"),
        transcriptDays: readDays("localTranscriptDays"),
        summaryDays: readDays("localSummaryDays"),
        isOrg,
    };

    if (
        policy.remoteOriginalDays === null &&
        policy.audioDays === null &&
        policy.transcriptDays === null &&
        policy.summaryDays === null
    ) {
        return NextResponse.json({ count: 0 });
    }

    const orgUserId = isOrg ? null : await getOrgUserId();
    const org = orgUserId ? await loadOrgRetentionContext(orgUserId) : null;
    const count = await countReapCandidates(policy, Date.now(), org);

    return NextResponse.json({ count });
});
