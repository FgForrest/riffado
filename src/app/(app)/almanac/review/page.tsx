import Link from "next/link";
import { getExtracted } from "next-intl/server";
import { SuggestedRelations } from "@/components/people/suggested-relations";
import { requireAuth } from "@/lib/auth-server";
import { isLearnDeploymentAvailable } from "@/lib/knowledge/availability";
import { groupPhrases } from "@/lib/knowledge/phrase-groups";
import {
    listVocabularyProposals,
    vocabularyVisibleTo,
} from "@/lib/knowledge/vocabulary";
import { reviewQueue } from "@/lib/learn/pending";
import { isOrgAccount } from "@/lib/org/config";
import { taskViewer } from "@/lib/tasks/access";
import { recordingsAwaitingTaskReview } from "@/lib/tasks/tasks";

export const dynamic = "force-dynamic";

/**
 * The Learn reviews waiting for the viewer, newest recording first: the
 * owner's on their own recordings (opened on their page), the organization
 * account's on shared ones (opened from the Organization library). The
 * organization account also decides the phrases members suggested, most
 * frequent first, alike ones grouped (Phase 6). Below, the recordings whose
 * proposed tasks wait for the viewer's review.
 */
export default async function ReviewQueuePage() {
    const session = await requireAuth();
    const i18n = await getExtracted();
    const organization = await isOrgAccount(session.user.id);
    const rows = isLearnDeploymentAvailable()
        ? await reviewQueue(session.user.id, organization)
        : [];
    const taskRows = await recordingsAwaitingTaskReview(
        await taskViewer({ id: session.user.id, email: session.user.email }),
    );
    const phrases = organization
        ? await listVocabularyProposals(session.user.id)
        : [];
    // What a suggestion may become: the Organization's and the core's.
    const vocabulary = organization
        ? await vocabularyVisibleTo(session.user.id, { sharedOnly: true })
        : { entityTypes: [], relationTypes: [] };
    const entityTypes = [
        { key: "person", label: i18n("Person") },
        ...vocabulary.entityTypes
            .filter((type) => !type.adoptedAsKey)
            .map((type) => ({ key: type.key, label: type.label })),
    ];
    const relationTypes = vocabulary.relationTypes
        .filter((type) => !type.adoptedAsKey)
        .map((type) => ({ key: type.key, label: type.label }));

    return (
        <div className="mx-auto max-w-3xl space-y-8">
            <section className="space-y-3">
                <h1 className="text-xl font-semibold">
                    {i18n("Waiting for review")}
                </h1>
                {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {i18n("Nothing waits for your review.")}
                    </p>
                ) : (
                    <ul className="divide-y rounded-lg border">
                        {rows.map((row) => (
                            <li
                                key={row.id}
                                className="flex items-center justify-between gap-4 p-3 text-sm"
                            >
                                <span className="min-w-0 truncate">
                                    {row.filename}
                                </span>
                                {organization ? (
                                    <Link
                                        href="/dashboard"
                                        className="shrink-0 text-primary hover:underline"
                                    >
                                        {i18n("Open the Organization library")}
                                    </Link>
                                ) : (
                                    <Link
                                        href={`/recordings/${row.id}`}
                                        className="shrink-0 text-primary hover:underline"
                                    >
                                        {i18n("Review")}
                                    </Link>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            {taskRows.length > 0 && (
                <section className="space-y-3">
                    <h2 className="text-lg font-semibold">
                        {i18n("Proposed tasks")}
                    </h2>
                    <ul className="divide-y rounded-lg border">
                        {taskRows.map((row) => (
                            <li
                                key={row.recordingId}
                                className="flex items-center justify-between gap-4 p-3 text-sm"
                            >
                                <span className="min-w-0 truncate">
                                    {row.title}
                                </span>
                                <span className="flex shrink-0 items-center gap-4">
                                    <span className="text-muted-foreground">
                                        {i18n(
                                            "{count, plural, one {# task} other {# tasks}}",
                                            { count: row.proposals },
                                        )}
                                    </span>
                                    <Link
                                        href={
                                            organization
                                                ? "/dashboard"
                                                : row.kind === "mail"
                                                  ? `/dashboard?recording=${encodeURIComponent(row.recordingId)}`
                                                  : `/recordings/${row.recordingId}`
                                        }
                                        className="text-primary hover:underline"
                                    >
                                        {organization
                                            ? i18n(
                                                  "Open the Organization library",
                                              )
                                            : i18n("Review")}
                                    </Link>
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {organization && (
                <section className="space-y-3">
                    <h2 className="text-lg font-semibold">
                        {i18n("Relations members suggested")}
                    </h2>
                    <SuggestedRelations
                        phrases={phrases}
                        groups={groupPhrases(phrases)}
                        entityTypes={entityTypes}
                        relationTypes={relationTypes}
                    />
                </section>
            )}
        </div>
    );
}
