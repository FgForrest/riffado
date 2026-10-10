import { and, eq, isNull, or } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { PersonDetail } from "@/components/people/person-detail";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import {
    chatterItems,
    recordings,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { auth } from "@/lib/auth";
import { decryptText } from "@/lib/encryption/fields";
import { listAliases } from "@/lib/knowledge/aliases";
import { almanacVocabulary } from "@/lib/knowledge/almanac-vocabulary";
import { factsForPage } from "@/lib/knowledge/fact-page";
import { getPerson } from "@/lib/knowledge/people";
import { vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";
import { getOrgUserId } from "@/lib/org/config";
import { sharedRecordingCondition } from "@/lib/sharing/shared";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export default async function PersonPage({ params }: Params) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) {
        redirect("/login");
    }

    const { id } = await params;
    const userId = session.user.id;

    const person = await getPerson(userId, id);
    if (!person) {
        notFound();
    }
    // A merged-away id lands on the person it was folded into.
    if (person.mergedIntoId) {
        redirect(`/almanac/${person.mergedIntoId}`);
    }
    // The viewer's own recordings, and the shared ones, which everyone may
    // open; nobody else's private transcripts are read.
    const orgUserId = await getOrgUserId();
    const [facts, otherNames, vocabulary] = await Promise.all([
        factsForPage(userId, orgUserId, { personId: id }),
        listAliases(userId, { personId: id }),
        vocabularyVisibleTo(userId),
    ]);
    const almanac = almanacVocabulary(vocabulary);

    // Where this person has been heard. Joined through the transcript rather
    // than the recording, because an attribution belongs to one transcript
    // and a recording may hold two -- so the same recording can arrive twice
    // and `PersonDetail` lists it once. Confirmed attributions only, the same
    // gate `/almanac` counts through, so the two surfaces cannot disagree
    // about how many recordings one person appears in.
    const appearances = await db
        .select({
            recordingId: recordings.id,
            filename: chatterItems.title,
            startTime: chatterItems.occurredAt,
            label: transcriptSpeakers.label,
            status: transcriptSpeakers.status,
            source: transcriptSpeakers.source,
            attributor: transcriptSpeakers.userId,
        })
        .from(transcriptSpeakers)
        .innerJoin(
            transcriptions,
            eq(transcriptions.id, transcriptSpeakers.transcriptionId),
        )
        .innerJoin(recordings, eq(recordings.id, transcriptions.recordingId))
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                or(
                    eq(transcriptSpeakers.userId, userId),
                    orgUserId ? sharedRecordingCondition(orgUserId) : undefined,
                ),
                eq(transcriptSpeakers.personId, id),
                eq(transcriptSpeakers.status, "confirmed"),
                isNull(recordings.deletedAt),
            ),
        );

    return (
        <div className="mx-auto w-full max-w-5xl">
            <PersonDetail
                person={{
                    id: person.id,
                    displayName: person.displayName,
                    primaryEmail: person.primaryEmail,
                    notes: person.notes,
                    scope: person.scope,
                }}
                // Private people are their owner's to erase; the
                // Organization's are the organization account's.
                canManage={person.scope === "personal" || userId === orgUserId}
                accountEmail={session.user.email}
                facts={facts}
                otherNames={otherNames.map((name) => ({
                    id: name.id,
                    text: name.text,
                    kind: name.kind,
                    scope: name.scope,
                }))}
                editing={{
                    subject: {
                        kind: "person",
                        id: person.id,
                        typeKey: "person",
                    },
                    relations: almanac.relations,
                    typeLabels: almanac.typeLabels,
                    ownScope: userId === orgUserId ? "org" : "personal",
                }}
                appearances={appearances
                    .map((row) => ({
                        recordingId: row.recordingId,
                        title: decryptText(row.filename),
                        recordedAt: row.startTime.toISOString(),
                        label: row.label,
                        status: row.status,
                        source: row.source,
                        // Someone else's recording is open only shared.
                        view:
                            row.attributor === userId
                                ? ("private" as const)
                                : ("org" as const),
                    }))
                    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))}
            />
        </div>
    );
}
