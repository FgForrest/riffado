import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { transcriptSpeakers } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import {
    deletePerson,
    getPerson,
    MAX_DISPLAY_NAME_LENGTH,
    mergePeople,
    updatePerson,
} from "@/lib/knowledge/people";

type IdContext = { params: Promise<{ id: string }> };

/** Every account whose transcripts name this person, the organization included. */
async function namingAccounts(personId: string): Promise<string[]> {
    const rows = await db
        .selectDistinct({ userId: transcriptSpeakers.userId })
        .from(transcriptSpeakers)
        .where(eq(transcriptSpeakers.personId, personId));
    return rows.map((row) => row.userId);
}

/**
 * Exported Markdown carries speaker names, so a rename, merge or erasure
 * re-plans the exports of everyone whose transcripts name the person --
 * an erasure request in particular must reach files on disk too.
 */
async function replanExports(accounts: Iterable<string>): Promise<void> {
    for (const userId of new Set(accounts)) {
        await enqueueExportPlansForUser(userId).catch((error) => {
            console.error("Failed to schedule export re-plan:", error);
        });
    }
}

const MAX_EMAIL_LENGTH = 320;

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;

    const person = await getPerson(session.user.id, id);
    if (!person) {
        throw new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
    }

    return NextResponse.json({ person });
});

/**
 * Rename a person or change their email.
 *
 * An Organization person is renamed for everyone, so only the organization
 * account may do it; the others get a 403 that says so.
 */
export const PATCH = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const body = (await request.json().catch(() => null)) as {
        displayName?: unknown;
        primaryEmail?: unknown;
    } | null;

    const changes: { displayName?: string; primaryEmail?: string | null } = {};
    if (body?.displayName !== undefined) {
        if (
            typeof body.displayName !== "string" ||
            body.displayName.trim().length > MAX_DISPLAY_NAME_LENGTH
        ) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Expected a name of reasonable length",
                400,
                { field: "displayName" },
            );
        }
        changes.displayName = body.displayName;
    }
    if (body?.primaryEmail !== undefined) {
        if (
            body.primaryEmail !== null &&
            (typeof body.primaryEmail !== "string" ||
                body.primaryEmail.trim().length > MAX_EMAIL_LENGTH)
        ) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Expected an email address or null",
                400,
                { field: "primaryEmail" },
            );
        }
        changes.primaryEmail = body.primaryEmail as string | null;
    }

    const person = await updatePerson(session.user.id, id, changes);
    await replanExports(await namingAccounts(id));
    return NextResponse.json({ person });
});

/**
 * Fold this person into another.
 *
 * A merge rather than a general update because it is the destructive one:
 * the losing row survives only as a tombstone, so it goes through an
 * explicit action instead of riding along on a field edit.
 *
 * Anyone may fold a private person into an Organization one; only the
 * organization account may merge Organization people.
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;

    const body = (await request.json().catch(() => null)) as {
        mergeIntoId?: unknown;
    } | null;

    const mergeIntoId = body?.mergeIntoId;
    if (typeof mergeIntoId !== "string" || !mergeIntoId) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "mergeIntoId is required",
            400,
            { field: "mergeIntoId" },
        );
    }
    if (mergeIntoId === id) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "A person cannot be merged into themselves",
            400,
            { field: "mergeIntoId" },
        );
    }

    const [person, target] = await Promise.all([
        getPerson(session.user.id, id),
        getPerson(session.user.id, mergeIntoId),
    ]);
    if (!person || !target) {
        throw new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
    }

    const affected = await namingAccounts(id);
    await mergePeople(session.user.id, mergeIntoId, id);
    await replanExports(affected);

    // The target may itself have been merged away since the caller read it,
    // in which case the rows land on the person it redirects to. Report that
    // person rather than the tombstone the request happened to name, so the
    // response describes where the data actually went.
    const winner = target.mergedIntoId
        ? await getPerson(session.user.id, target.mergedIntoId)
        : target;

    return NextResponse.json({ person: winner ?? target });
});

/**
 * Erase a person.
 *
 * A named third party asking to be removed is a data-subject request, so it
 * is one action. The transcript keeps its raw speaker label and simply loses
 * the name, which is right -- the recording is not the thing being erased.
 * Only the organization account erases an Organization person.
 */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;

    const person = await getPerson(session.user.id, id);
    if (!person) {
        throw new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
    }

    const affected = await namingAccounts(id);
    await deletePerson(session.user.id, id);
    await replanExports(affected);

    return NextResponse.json({ deleted: true });
});
