import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { removeFolderAlias } from "@/lib/mail/folder-addresses";
import { requireMailEnabled } from "@/lib/mail/require-mail";

type Context = { params: Promise<{ id: string; addressId: string }> };

/** Stops one of the folder's secondary addresses for good. */
export const DELETE = apiHandler<Context>(async (request, context) => {
    requireMailEnabled();
    const session = await requireApiSession(request);
    const { id, addressId } = await (context as Context).params;
    await removeFolderAlias({
        userId: session.user.id,
        folderId: id,
        addressId,
    });
    return NextResponse.json({ success: true });
});
