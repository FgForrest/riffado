import { NextResponse } from "next/server";
import {
    countMailReapCandidates,
    type MailRetentionPolicy,
} from "@/db/queries/mail-retention";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { getOrgUserId, isOrgAccount } from "@/lib/org/config";

/**
 * How many mails the given mail retention policy would reap right now,
 * under the rules the sweep deletes by: the organization account's
 * governs shared mail, everyone else's the rest of their own. Taken from
 * the query string, before it is saved. Read-only.
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
    const isOrg = await isOrgAccount(session.user.id);
    const policy: MailRetentionPolicy = {
        userId: session.user.id,
        rawDays: readDays("rawDays"),
        contentDays: readDays("contentDays"),
        summaryDays: readDays("summaryDays"),
        isOrg,
    };
    const orgUserId = await getOrgUserId();
    if (isOrg && session.user.id !== orgUserId) {
        return NextResponse.json({ count: 0 });
    }
    return NextResponse.json({
        count: await countMailReapCandidates(policy, Date.now(), orgUserId),
    });
});
