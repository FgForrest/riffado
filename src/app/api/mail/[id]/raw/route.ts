import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { mailRawPath } from "@/lib/mail/detail";
import { readRawMail } from "@/lib/mail/raw-storage";
import { contentDispositionAttachment } from "@/lib/recordings/filename";

type IdContext = { params: Promise<{ id: string }> };

/** The caller's mail as it arrived, as an `.eml` download. */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const path = await mailRawPath(session.user.id, id);
    if (!path) throw new AppError(ErrorCode.NOT_FOUND, "Mail not found", 404);
    const raw = await readRawMail(session.user.id, path);
    return new Response(new Uint8Array(raw), {
        headers: {
            "Content-Type": "message/rfc822",
            "Content-Disposition": contentDispositionAttachment(`${id}.eml`),
            "Content-Length": String(raw.length),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    });
});
