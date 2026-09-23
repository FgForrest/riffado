import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    addRecordingToFolder,
    moveRecordingBetweenFolders,
    removeRecordingFromFolder,
    unshareRecording,
} from "@/lib/folders/folders";

type IdContext = { params: Promise<{ id: string }> };

function readString(body: unknown, field: string): string {
    const value =
        typeof body === "object" && body !== null && field in body
            ? (body as Record<string, unknown>)[field]
            : null;
    if (typeof value !== "string" || !value) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            `${field} is required`,
            400,
            { field },
        );
    }
    return value;
}

/** File a recording in a folder. An Organization folder shares it (owner only). */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const folderId = readString(
        await request.json().catch(() => null),
        "folderId",
    );
    await addRecordingToFolder({
        userId: session.user.id,
        recordingId: id,
        folderId,
    });
    return NextResponse.json({ assigned: true });
});

/** Move a recording from one folder to another in the same tree. */
export const PATCH = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const body = await request.json().catch(() => null);
    await moveRecordingBetweenFolders({
        userId: session.user.id,
        recordingId: id,
        fromFolderId: readString(body, "fromFolderId"),
        toFolderId: readString(body, "toFolderId"),
    });
    return NextResponse.json({ moved: true });
});

/**
 * Take a recording out of a folder, or with `{ "organization": true }` out of
 * the whole Organization tree. Leaving the Organization is owner only.
 */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const body = await request.json().catch(() => null);
    if (
        typeof body === "object" &&
        body !== null &&
        (body as { organization?: unknown }).organization === true
    ) {
        await unshareRecording(session.user.id, id);
        return NextResponse.json({ shared: false });
    }
    await removeRecordingFromFolder({
        userId: session.user.id,
        recordingId: id,
        folderId: readString(body, "folderId"),
    });
    return NextResponse.json({ assigned: false });
});
