import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { mailRawPath } from "@/lib/mail/detail";
import { readAttachment } from "@/lib/mail/parse";
import { readRawMail } from "@/lib/mail/raw-storage";
import { contentDispositionAttachment } from "@/lib/recordings/filename";

type Context = { params: Promise<{ id: string; index: string }> };

/**
 * One attachment of the caller's mail, read from the stored message, as a
 * download only: never rendered by the browser.
 */
export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id, index } = await (context as Context).params;
    const position = Number(index);
    const notFound = new AppError(
        ErrorCode.NOT_FOUND,
        "Attachment not found",
        404,
    );
    if (!Number.isInteger(position) || position < 0) throw notFound;
    const path = await mailRawPath(session.user.id, id);
    if (!path) throw notFound;
    const attachment = await readAttachment(
        await readRawMail(session.user.id, path),
        position,
    );
    if (!attachment) throw notFound;
    const filename =
        attachment.meta.filename?.replace(/[\r\n"\\/]/g, "_").slice(0, 200) ||
        `attachment-${position + 1}`;
    return new Response(new Uint8Array(attachment.content), {
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": contentDispositionAttachment(filename),
            "Content-Length": String(attachment.content.length),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cache-Control": "private, no-store",
        },
    });
});
