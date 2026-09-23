import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { isGoogleIntegrationAvailable } from "@/lib/integrations/google/config";
import {
    disconnectGoogle,
    getGoogleConnectionStatus,
} from "@/lib/integrations/google/connection";

export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const available = isGoogleIntegrationAvailable();
    const connection = available
        ? await getGoogleConnectionStatus(session.user.id)
        : null;
    return NextResponse.json({
        available,
        connection: connection
            ? {
                  email: connection.email,
                  hostedDomain: connection.hostedDomain,
                  status: connection.status,
              }
            : null,
    });
});

export const DELETE = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const disconnected = await disconnectGoogle(session.user.id);
    return NextResponse.json({ disconnected });
});
