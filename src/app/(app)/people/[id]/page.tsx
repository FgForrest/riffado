import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { AppNav } from "@/components/app-nav";
import { PersonDetail } from "@/components/people/person-detail";
import { db } from "@/db";
import { recordings, transcriptions, transcriptSpeakers } from "@/db/schema";
import { auth } from "@/lib/auth";
import { decryptText } from "@/lib/encryption/fields";
import { getPerson } from "@/lib/knowledge/people";

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

    // Where this person has been heard. Joined through the transcript rather
    // than the recording, because an attribution belongs to one transcript
    // and a recording may hold two -- so the same recording can arrive twice
    // and `PersonDetail` lists it once. Confirmed attributions only, the same
    // gate `/people` counts through, so the two surfaces cannot disagree
    // about how many recordings one person appears in.
    const appearances = await db
        .select({
            recordingId: recordings.id,
            filename: recordings.filename,
            startTime: recordings.startTime,
            label: transcriptSpeakers.label,
            status: transcriptSpeakers.status,
            source: transcriptSpeakers.source,
        })
        .from(transcriptSpeakers)
        .innerJoin(
            transcriptions,
            eq(transcriptions.id, transcriptSpeakers.transcriptionId),
        )
        .innerJoin(recordings, eq(recordings.id, transcriptions.recordingId))
        .where(
            and(
                eq(transcriptSpeakers.userId, userId),
                eq(transcriptSpeakers.personId, id),
                eq(transcriptSpeakers.status, "confirmed"),
                isNull(recordings.deletedAt),
            ),
        );

    return (
        <div className="container mx-auto max-w-7xl px-4 py-6">
            <AppHeader>
                <AppNav className="min-w-0" />
            </AppHeader>

            <div className="mx-auto w-full max-w-5xl">
                <PersonDetail
                    person={{
                        id: person.id,
                        displayName: person.displayName,
                        primaryEmail: person.primaryEmail,
                        notes: person.notes,
                    }}
                    appearances={appearances
                        .map((row) => ({
                            recordingId: row.recordingId,
                            title: decryptText(row.filename),
                            recordedAt: row.startTime.toISOString(),
                            label: row.label,
                            status: row.status,
                            source: row.source,
                        }))
                        .sort((a, b) =>
                            b.recordedAt.localeCompare(a.recordedAt),
                        )}
                />
            </div>
        </div>
    );
}
