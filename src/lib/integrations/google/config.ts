import { env } from "@/lib/env";

export const GOOGLE_DRIVE_FILE_SCOPE =
    "https://www.googleapis.com/auth/drive.file";

/** Scopes asked for on connect. Later integrations add theirs incrementally. */
export const GOOGLE_CONNECT_SCOPES = [
    "openid",
    "email",
    GOOGLE_DRIVE_FILE_SCOPE,
];

export interface GoogleIntegrationConfig {
    clientId: string;
    clientSecret: string;
    pickerApiKey: string;
    projectNumber: string;
    /** Lowercase Workspace domains allowed to connect; empty allows any. */
    workspaceDomains: string[];
    redirectUri: string;
}

/**
 * The Google integration's settings, or null where it is off: on hosted
 * deployments, and wherever any of the four required variables is unset.
 */
export function getGoogleIntegrationConfig(): GoogleIntegrationConfig | null {
    if (
        env.IS_HOSTED ||
        !env.GOOGLE_CLIENT_ID ||
        !env.GOOGLE_CLIENT_SECRET ||
        !env.GOOGLE_PICKER_API_KEY ||
        !env.GOOGLE_CLOUD_PROJECT_NUMBER ||
        !env.APP_URL
    ) {
        return null;
    }
    return {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        pickerApiKey: env.GOOGLE_PICKER_API_KEY,
        projectNumber: env.GOOGLE_CLOUD_PROJECT_NUMBER,
        workspaceDomains: env.GOOGLE_WORKSPACE_DOMAINS ?? [],
        redirectUri: new URL(
            "/api/integrations/google/callback",
            env.APP_URL,
        ).toString(),
    };
}

export function isGoogleIntegrationAvailable(): boolean {
    return getGoogleIntegrationConfig() !== null;
}
