import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { labelAddress, removeAddress } from "@/lib/mail/addresses";
import { requireMailEnabled } from "@/lib/mail/require-mail";

type IdContext = { params: Promise<{ id: string }> };

const labelSchema = z.object({ label: z.string().max(100).nullable() });

/** Renames one of the caller's secret addresses. */
export const PATCH = apiHandler<IdContext>(async (request, context) => {
    requireMailEnabled();
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const parsed = labelSchema.safeParse(
        await request.json().catch(() => undefined),
    );
    if (!parsed.success) {
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid request", 400);
    }
    await labelAddress({
        userId: session.user.id,
        addressId: id,
        label: parsed.data.label,
    });
    return NextResponse.json({ success: true });
});

/** Stops one of the caller's secret or secondary addresses for good. */
export const DELETE = apiHandler<IdContext>(async (request, context) => {
    requireMailEnabled();
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    await removeAddress({ userId: session.user.id, addressId: id });
    return NextResponse.json({ success: true });
});
