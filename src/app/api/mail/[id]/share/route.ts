import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { dismissPendingShare, shareMail } from "@/lib/mail/manage";

type IdContext = { params: Promise<{ id: string }> };

const bodySchema = z.object({
    folderId: z.string().min(1).max(64),
    action: z.enum(["share", "dismiss"]).default("share"),
});

/**
 * Shares the caller's mail into the Organization folder it was sent to,
 * through the share gate, or drops that wish (`action: "dismiss"`).
 */
export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const parsed = bodySchema.safeParse(
        await request.json().catch(() => undefined),
    );
    if (!parsed.success) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid request", 400);
    }
    const input = {
        ownerUserId: session.user.id,
        itemId: id,
        folderId: parsed.data.folderId,
    };
    if (parsed.data.action === "dismiss") await dismissPendingShare(input);
    else await shareMail(input);
    return NextResponse.json({ success: true });
});
