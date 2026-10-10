import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { createSecretAddress } from "@/lib/mail/addresses";
import { requireMailEnabled } from "@/lib/mail/require-mail";
import { loadMailSettings, toAddressView } from "@/lib/mail/views";

const createSchema = z.object({
    baseAddressId: z.string().min(1).max(64),
    label: z.string().max(100).nullish(),
});

/** The caller's mail addresses: mailbox, folder addresses, secrets. */
export const GET = apiHandler(async (request) => {
    requireMailEnabled();
    const session = await requireApiSession(request);
    return NextResponse.json(await loadMailSettings(session.user.id), {
        headers: { "Cache-Control": "private, no-store" },
    });
});

/** A new secret address extending one of the caller's own addresses. */
export const POST = apiHandler(async (request) => {
    requireMailEnabled();
    const session = await requireApiSession(request);
    const parsed = createSchema.safeParse(
        await request.json().catch(() => undefined),
    );
    if (!parsed.success) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid request", 400);
    }
    const address = await createSecretAddress({
        userId: session.user.id,
        baseAddressId: parsed.data.baseAddressId,
        label: parsed.data.label ?? null,
    });
    return NextResponse.json(
        { address: toAddressView(address) },
        { status: 201 },
    );
});
