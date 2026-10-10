import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { requireMailEnabled } from "@/lib/mail/require-mail";
import { loadDeliveryLog } from "@/lib/mail/views";

/** What became of mail sent to the caller's addresses, newest first. */
export const GET = apiHandler(async (request) => {
    requireMailEnabled();
    const session = await requireApiSession(request);
    return NextResponse.json(
        { entries: await loadDeliveryLog(session.user.id) },
        { headers: { "Cache-Control": "private, no-store" } },
    );
});
