import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { getGoogleIntegrationConfig } from "@/lib/integrations/google/config";
import { getGoogleAccessToken } from "@/lib/integrations/google/connection";
import { GoogleConnectionUnavailableError } from "@/lib/integrations/google/errors";

/**
 * What the browser needs to open the Google Picker: a short-lived access
 * token of the user's own account (scoped to files the app may touch), the
 * Picker API key and the project number.
 */
export const GET = apiHandler(async (request) => {
    const session = await requireApiSession(request);
    const config = getGoogleIntegrationConfig();
    if (!config) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "The Google integration is not configured",
            404,
        );
    }
    let accessToken: string;
    try {
        accessToken = await getGoogleAccessToken(session.user.id);
    } catch (error) {
        if (error instanceof GoogleConnectionUnavailableError) {
            throw new AppError(ErrorCode.CONFLICT, error.message, 409, {
                problem: error.problem,
            });
        }
        throw error;
    }
    return NextResponse.json(
        {
            accessToken,
            apiKey: config.pickerApiKey,
            appId: config.projectNumber,
            clientId: config.clientId,
        },
        { headers: { "Cache-Control": "no-store" } },
    );
});
