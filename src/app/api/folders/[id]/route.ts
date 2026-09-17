import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { deleteFolder, moveFolder, renameFolder } from "@/lib/folders/folders";

type IdContext = { params: Promise<{ id: string }> };

export const PATCH = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const body = (await request.json().catch(() => null)) as {
        name?: unknown;
        parentId?: unknown;
    } | null;
    if (!body) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid request", 400);
    }

    if (body.name !== undefined) {
        if (typeof body.name !== "string") {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Folder name must be text",
                400,
                { field: "name" },
            );
        }
        const folder = await renameFolder({
            userId: session.user.id,
            folderId: id,
            name: body.name,
        });
        return NextResponse.json({ folder });
    }

    if (typeof body.parentId === "string") {
        const folder = await moveFolder({
            userId: session.user.id,
            folderId: id,
            parentId: body.parentId,
        });
        return NextResponse.json({ folder });
    }

    throw new AppError(
        ErrorCode.INVALID_INPUT,
        "A new name or parent is required",
        400,
    );
});

export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    await deleteFolder(session.user.id, id);
    return NextResponse.json({ deleted: true });
});
