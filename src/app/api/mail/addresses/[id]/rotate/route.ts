import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { rotateSecretAddress } from "@/lib/mail/addresses";
import { requireMailEnabled } from "@/lib/mail/require-mail";
import { toAddressView } from "@/lib/mail/views";

type IdContext = { params: Promise<{ id: string }> };

/** Replaces one of the caller's secret addresses with a new token. */
export const POST = apiHandler<IdContext>(async (request, context) => {
    requireMailEnabled();
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const address = await rotateSecretAddress({
        userId: session.user.id,
        addressId: id,
    });
    return NextResponse.json({ address: toAddressView(address) });
});
