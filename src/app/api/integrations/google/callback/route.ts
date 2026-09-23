import { type NextRequest, NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { env } from "@/lib/env";
import { apiHandler } from "@/lib/errors";
import {
    completeGoogleConnect,
    returnUrlWithOutcome,
} from "@/lib/integrations/google/connect-flow";
import {
    GOOGLE_OAUTH_COOKIE,
    GOOGLE_OAUTH_COOKIE_PATH,
} from "@/lib/integrations/google/oauth-state";

/** Google's redirect back after consent. */
export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const url = new URL(request.url);
    const result = await completeGoogleConnect({
        userId: session.user.id,
        sealedState: (request as NextRequest).cookies.get(GOOGLE_OAUTH_COOKIE)
            ?.value,
        params: url.searchParams,
    });
    const response = NextResponse.redirect(
        returnUrlWithOutcome(
            result.returnTo,
            result.outcome,
            env.APP_URL ?? url.origin,
        ),
        302,
    );
    response.cookies.set(GOOGLE_OAUTH_COOKIE, "", {
        path: GOOGLE_OAUTH_COOKIE_PATH,
        maxAge: 0,
    });
    return response;
});
