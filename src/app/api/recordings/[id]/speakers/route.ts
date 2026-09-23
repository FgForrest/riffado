import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { refreshExistingRecordingSidecars } from "@/lib/export/document-sidecars";
import {
    getTranscriptSpeakers,
    setTranscriptSpeaker,
    type TranscriptSpeaker,
} from "@/lib/knowledge/attribution";
import {
    createPerson,
    getPerson,
    MAX_DISPLAY_NAME_LENGTH,
    promotePerson,
} from "@/lib/knowledge/people";
import { assertOrgScopeWritable, isOrgScopeEnabled } from "@/lib/org/config";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { orgContentChanged } from "@/lib/sharing/notify";
import { ensureOrgTranscript } from "@/lib/sharing/org-transcript";
import { effectiveViewReader } from "@/lib/sharing/view-content";

type IdContext = { params: Promise<{ id: string }> };

const MAX_LABEL_LENGTH = 64;

function requestedSource(request: Request): string {
    return new URL(request.url).searchParams.get("source") ?? "riffado";
}

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);

    if (view === "org") {
        const access = await requireRecordingView(session.user.id, id, view);
        const reader = await effectiveViewReader(id, access, "transcript");
        const transcript = await requireTranscript(reader.userId, id, request);
        const speakers = await getTranscriptSpeakers(
            reader.userId,
            transcript.id,
            { orgPeopleOnly: true },
        );
        // On the owner's transcript only confirmed names are shown: a
        // machine's guess there is the owner's to review, not everyone's to
        // read. The Organization's own transcript is everyone's to curate,
        // suggestions included.
        return NextResponse.json({
            transcriptionId: transcript.id,
            fallback: reader.fallback,
            speakers: reader.fallback
                ? speakers.filter((speaker) => speaker.status === "confirmed")
                : speakers,
        });
    }

    await requireRecordingView(session.user.id, id, "private");
    const transcript = await requireTranscript(session.user.id, id, request);

    return NextResponse.json({
        transcriptionId: transcript.id,
        speakers: await getTranscriptSpeakers(session.user.id, transcript.id),
    });
});

interface SpeakerChange {
    label: string;
    personId?: string;
    displayName?: string;
}

function readChange(body: unknown): SpeakerChange {
    const value = (body ?? {}) as {
        label?: unknown;
        personId?: unknown;
        displayName?: unknown;
    };
    const label = value.label;
    if (typeof label !== "string" || !label.trim()) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "label is required",
            400,
            { field: "label" },
        );
    }
    if (label.length > MAX_LABEL_LENGTH) {
        throw new AppError(ErrorCode.INVALID_INPUT, "label is too long", 400, {
            field: "label",
        });
    }
    const change: SpeakerChange = { label: label.trim() };
    if (typeof value.personId === "string" && value.personId) {
        change.personId = value.personId;
    } else if (
        typeof value.displayName === "string" &&
        value.displayName.trim()
    ) {
        const displayName = value.displayName.trim();
        if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "That name is too long",
                400,
                { field: "displayName" },
            );
        }
        change.displayName = displayName;
    }
    return change;
}

/**
 * Name a speaker, or clear the name.
 *
 * Accepts either an existing `personId` or a `displayName` to create one,
 * because the common case is naming somebody the knowledge base has never
 * heard of and making the user create them first would be a needless step.
 *
 * Anything set here is `confirmed` with source `user`: it came from a person
 * looking at the transcript, which is the only evidence this feature treats
 * as strong enough to reach a summary or an export.
 *
 * `?view=org` names a speaker of the Organization view, for everyone: only
 * Organization people may be picked, a new name becomes an Organization
 * person, and the owner's own transcript is never touched.
 */
export const PUT = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);
    const access = await requireRecordingView(session.user.id, id, view);
    const change = readChange(await request.json().catch(() => null));

    if (view === "org" && access.orgUserId) {
        assertOrgScopeWritable();
        const orgUserId = access.orgUserId;

        // Checked before anything is copied, so a bad request leaves no trace.
        let personId: string | null = null;
        if (change.personId) {
            const person = await currentPerson(
                session.user.id,
                change.personId,
            );
            if (!person || person.scope !== "org") {
                throw new AppError(
                    ErrorCode.NOT_FOUND,
                    "Person not found",
                    404,
                );
            }
            personId = person.id;
        }
        const transcript = await ensureOrgTranscript(
            id,
            requestedSource(request),
            access,
            session.user.id,
        );
        if (!personId && change.displayName) {
            const created = await createPerson({
                userId: orgUserId,
                displayName: change.displayName,
                createdByUserId: session.user.id,
            });
            personId = created.id;
        }

        await setTranscriptSpeaker({
            userId: orgUserId,
            transcriptionId: transcript.id,
            label: change.label,
            personId,
            source: "user",
            status: "confirmed",
        });
        await orgContentChanged(id);
        return NextResponse.json({
            speakers: await getTranscriptSpeakers(orgUserId, transcript.id, {
                orgPeopleOnly: true,
            }),
        });
    }

    const transcript = await requireTranscript(session.user.id, id, request);

    // A null personId is meaningful: it clears the attribution and returns
    // the label to unresolved, which is always an acceptable answer.
    let personId: string | null = null;

    if (change.personId) {
        const person = await currentPerson(session.user.id, change.personId);
        if (!person) {
            throw new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
        }
        personId = person.id;
    } else if (change.displayName) {
        const created = await createPerson({
            userId: session.user.id,
            displayName: change.displayName,
        });
        personId = created.id;
    }

    await setTranscriptSpeaker({
        userId: session.user.id,
        transcriptionId: transcript.id,
        label: change.label,
        personId,
        source: "user",
        status: "confirmed",
    });

    // While the Organization view still shows this transcript, a name
    // confirmed on it is a name everyone reads, so its person joins the
    // Organization's knowledge base.
    if (personId && access.shared && access.orgUserId && isOrgScopeEnabled()) {
        const reader = await effectiveViewReader(
            id,
            {
                ownerUserId: access.ownerUserId,
                contentUserId: access.orgUserId,
            },
            "transcript",
        );
        if (reader.fallback) {
            await promotePerson(personId, access.orgUserId);
            await orgContentChanged(id);
        }
    }

    // A rename changes what every downstream reader of this recording sees,
    // and `GET /api/v1/recordings` pages on `updatedAt`, so a client syncing
    // incrementally would otherwise never learn about it.
    await db
        .update(recordings)
        .set({ updatedAt: new Date() })
        .where(
            and(eq(recordings.id, id), eq(recordings.userId, session.user.id)),
        );

    await refreshExistingRecordingSidecars(session.user.id, id);

    const speakers: TranscriptSpeaker[] = await getTranscriptSpeakers(
        session.user.id,
        transcript.id,
    );
    return NextResponse.json({ speakers });
});

/**
 * The person an id refers to now: a merged-away id resolves to the person
 * it was folded into, so an attribution never lands on a tombstone.
 */
async function currentPerson(userId: string, personId: string) {
    const person = await getPerson(userId, personId);
    if (!person?.mergedIntoId) return person;
    return getPerson(userId, person.mergedIntoId);
}

// The transcript an attribution attaches to.
//
// A recording can hold more than one transcript, and their speaker labels
// are not interchangeable, so the caller says which by source. Defaults to
// the user's own.
async function requireTranscript(
    userId: string,
    recordingId: string,
    request: Request,
): Promise<{ id: string }> {
    const [transcript] = await db
        .select({ id: transcriptions.id })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, requestedSource(request)),
            ),
        )
        .limit(1);

    if (!transcript) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "No transcript to attribute",
            404,
        );
    }

    return transcript;
}
