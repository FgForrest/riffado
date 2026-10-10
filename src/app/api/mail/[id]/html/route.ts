import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { mailRawPath } from "@/lib/mail/detail";
import { renderMailHtml } from "@/lib/mail/html-view";
import { readRawMail } from "@/lib/mail/raw-storage";

type IdContext = { params: Promise<{ id: string }> };

/**
 * The caller's mail as sanitized HTML, for an empty-`sandbox` iframe's
 * `srcdoc`: `{ html: null }` when it has none.
 */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const path = await mailRawPath(session.user.id, id);
    if (!path) throw new AppError(ErrorCode.NOT_FOUND, "Mail not found", 404);
    const html = await renderMailHtml(await readRawMail(session.user.id, path));
    return NextResponse.json(
        { html },
        { headers: { "Cache-Control": "private, no-store" } },
    );
});
