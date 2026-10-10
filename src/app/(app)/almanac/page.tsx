import { and, countDistinct, eq, isNull, max, or } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getExtracted } from "next-intl/server";
import { PeopleList } from "@/components/people/people-list";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import {
    chatterItems,
    recordings,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { auth } from "@/lib/auth";
import { aliasTextsVisibleTo } from "@/lib/knowledge/aliases";
import { isLearnDeploymentAvailable } from "@/lib/knowledge/availability";
import { listPeople } from "@/lib/knowledge/people";
import { pendingReviewCount } from "@/lib/learn/pending";
import { getOrgUserId, isOrgAccount } from "@/lib/org/config";
import { sharedRecordingCondition } from "@/lib/sharing/shared";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) {
        redirect("/login");
    }

    const userId = session.user.id;
    // The names on shared recordings count too, which everyone may see.
    const orgUserId = await getOrgUserId();

    const [rows, nicknames, appearances, pendingReviews] = await Promise.all([
        listPeople(userId),
        aliasTextsVisibleTo(userId, "person"),
        // How many recordings each person appears in, and when they were last
        // heard. Both come from the attribution overlay joined back to the
        // recording, which is the only place that link exists.
        db
            .select({
                personId: transcriptSpeakers.personId,
                recordingCount: countDistinct(recordings.id),
                lastSeen: max(chatterItems.occurredAt),
            })
            .from(transcriptSpeakers)
            .innerJoin(
                transcriptions,
                eq(transcriptions.id, transcriptSpeakers.transcriptionId),
            )
            .innerJoin(
                recordings,
                eq(recordings.id, transcriptions.recordingId),
            )
            .innerJoin(chatterItems, recordingItemJoin)
            .where(
                and(
                    or(
                        eq(transcriptSpeakers.userId, userId),
                        orgUserId
                            ? sharedRecordingCondition(orgUserId)
                            : undefined,
                    ),
                    eq(transcriptSpeakers.status, "confirmed"),
                    isNull(recordings.deletedAt),
                ),
            )
            .groupBy(transcriptSpeakers.personId),
        isLearnDeploymentAvailable()
            ? isOrgAccount(userId).then((organization) =>
                  pendingReviewCount(userId, organization),
              )
            : 0,
    ]);
    const i18n = await getExtracted();

    const stats = new Map(
        appearances.map((row) => [
            row.personId,
            { recordingCount: row.recordingCount, lastSeen: row.lastSeen },
        ]),
    );

    return (
        <div>
            {pendingReviews > 0 && (
                <Link
                    href="/almanac/review"
                    className="mb-4 flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 px-4 py-2 text-sm hover:bg-primary/10"
                >
                    {i18n(
                        "{count, plural, one {# Learn review waits for you} other {# Learn reviews wait for you}}",
                        { count: pendingReviews },
                    )}
                    <span className="font-medium text-primary">
                        {i18n("Open the queue")}
                    </span>
                </Link>
            )}
            <PeopleList
                people={rows.map((row) => ({
                    id: row.id,
                    displayName: row.displayName,
                    primaryEmail: row.primaryEmail,
                    scope: row.scope,
                    recordingCount: stats.get(row.id)?.recordingCount ?? 0,
                    lastSeen:
                        stats.get(row.id)?.lastSeen?.toISOString() ?? null,
                    nicknames: nicknames.get(row.id) ?? [],
                }))}
            />
        </div>
    );
}
