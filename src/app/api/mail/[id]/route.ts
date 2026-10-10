import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { loadMailDetail } from "@/lib/mail/detail";
import { deleteMail } from "@/lib/mail/manage";

type IdContext = { params: Promise<{ id: string }> };

/** The caller's own mail, decrypted: headers, segments, attachments. */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const detail = await loadMailDetail(session.user.id, id);
    if (!detail) {
        throw new AppError(ErrorCode.NOT_FOUND, "Mail not found", 404);
    }
    return NextResponse.json(detail, {
        headers: { "Cache-Control": "private, no-store" },
    });
});

/** Deletes the caller's mail for good. */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    await deleteMail(session.user.id, id);
    return NextResponse.json({ success: true });
});
