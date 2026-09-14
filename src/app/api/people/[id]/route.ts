import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { deletePerson, getPerson, mergePeople } from "@/lib/knowledge/people";

type IdContext = { params: Promise<{ id: string }> };

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
 * Fold this person into another.
 *
 * A merge rather than a general update because it is the destructive one:
 * the losing row survives only as a tombstone, so it goes through an
 * explicit action instead of riding along on a field edit.
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

    await mergePeople(session.user.id, mergeIntoId, id);

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
 * is one action. Attributions cascade; the transcript keeps its raw speaker
 * label and simply loses the name, which is right -- the recording is not
 * the thing being erased.
 */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;

    const person = await getPerson(session.user.id, id);
    if (!person) {
        throw new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
    }

    await deletePerson(session.user.id, id);

    return NextResponse.json({ deleted: true });
});
