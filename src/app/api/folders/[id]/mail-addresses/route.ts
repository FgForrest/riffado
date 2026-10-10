import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    loadFolderAddresses,
    setFolderAlias,
} from "@/lib/mail/folder-addresses";
import { requireMailEnabled } from "@/lib/mail/require-mail";

type IdContext = { params: Promise<{ id: string }> };

const aliasSchema = z.object({ alias: z.string().min(1).max(64) });

/**
 * The folder's live addresses, current first; `?subtree=1` adds its
 * subfolders', which deleting the folder stops for good.
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    requireMailEnabled();
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const subtree = new URL(request.url).searchParams.get("subtree") === "1";
    const result = await loadFolderAddresses(session.user.id, id, { subtree });
    if (!result) {
        throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    }
    return NextResponse.json(result, {
        headers: { "Cache-Control": "private, no-store" },
    });
});

/** Gives the folder a new address; the old one stays as secondary. */
export const PUT = apiHandler<IdContext>(async (request, context) => {
    requireMailEnabled();
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const parsed = aliasSchema.safeParse(
        await request.json().catch(() => undefined),
    );
    if (!parsed.success) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid request", 400, {
            field: "alias",
        });
    }
    const address = await setFolderAlias({
        userId: session.user.id,
        folderId: id,
        alias: parsed.data.alias,
    });
    return NextResponse.json({ address });
});
