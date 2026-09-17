import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    addRecordingToFolder,
    removeRecordingFromFolder,
} from "@/lib/folders/folders";

type IdContext = { params: Promise<{ id: string }> };

function readFolderId(body: unknown): string {
    const folderId =
        typeof body === "object" && body !== null && "folderId" in body
            ? (body as { folderId: unknown }).folderId
            : null;
    if (typeof folderId !== "string" || !folderId) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "folderId is required",
            400,
            { field: "folderId" },
        );
    }
    return folderId;
}

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const folderId = readFolderId(await request.json().catch(() => null));
    await addRecordingToFolder({
        userId: session.user.id,
        recordingId: id,
        folderId,
    });
    return NextResponse.json({ assigned: true });
});

export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const folderId = readFolderId(await request.json().catch(() => null));
    await removeRecordingFromFolder({
        userId: session.user.id,
        recordingId: id,
        folderId,
    });
    return NextResponse.json({ assigned: false });
});
