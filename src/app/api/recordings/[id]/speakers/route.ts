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
} from "@/lib/knowledge/attribution";
import {
    createPerson,
    getPerson,
    MAX_DISPLAY_NAME_LENGTH,
} from "@/lib/knowledge/people";

type IdContext = { params: Promise<{ id: string }> };

const MAX_LABEL_LENGTH = 64;

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;

    const transcript = await requireTranscript(session.user.id, id, request);

    return NextResponse.json({
        transcriptionId: transcript.id,
        speakers: await getTranscriptSpeakers(session.user.id, transcript.id),
    });
});

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
 */
export const PUT = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;

    const body = (await request.json().catch(() => null)) as {
        label?: unknown;
        personId?: unknown;
        displayName?: unknown;
        source?: unknown;
    } | null;

    const label = body?.label;
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

    const transcript = await requireTranscript(session.user.id, id, request);

    // A null personId is meaningful: it clears the attribution and returns
    // the label to unresolved, which is always an acceptable answer.
    let personId: string | null = null;

    if (typeof body?.personId === "string" && body.personId) {
        const person = await getPerson(session.user.id, body.personId);
        if (!person) {
            throw new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
        }
        personId = person.id;
    } else if (
        typeof body?.displayName === "string" &&
        body.displayName.trim()
    ) {
        const displayName = body.displayName.trim();
        if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "That name is too long",
                400,
                { field: "displayName" },
            );
        }
        const created = await createPerson({
            userId: session.user.id,
            displayName,
        });
        personId = created.id;
    }

    await setTranscriptSpeaker({
        userId: session.user.id,
        transcriptionId: transcript.id,
        label: label.trim(),
        personId,
        source: "user",
        status: "confirmed",
    });

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

    return NextResponse.json({
        speakers: await getTranscriptSpeakers(session.user.id, transcript.id),
    });
});

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
    const source = new URL(request.url).searchParams.get("source") ?? "riffado";

    const [transcript] = await db
        .select({ id: transcriptions.id })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, source),
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
