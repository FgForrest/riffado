import { AppError, ErrorCode } from "@/lib/errors";
import {
    getGoogleAccessToken,
    getGoogleConnectionStatus,
    googleAccessTokenSource,
    invalidateGoogleAccessToken,
} from "./connection";
import { createDriveClient, DRIVE_FOLDER_MIME } from "./drive-client";
import { GoogleApiError, GoogleConnectionUnavailableError } from "./errors";

const DRIVE_ID_SHAPE = /^[A-Za-z0-9_-]{1,200}$/;

export interface InspectedDriveFolder {
    id: string;
    name: string;
    /** Shared drive holding the folder; null for My Drive. */
    driveId: string | null;
    /** Google `sub` of the account that can write into it. */
    accountSubject: string;
}

function unavailable(message: string): AppError {
    return new AppError(ErrorCode.INVALID_INPUT, message, 400, {
        field: "rootFolderId",
    });
}

/**
 * Checks, through the user's connected account, that `folderId` is a
 * folder that account can add files to. The Picker already granted the app
 * access to it; this is what makes the choice trustworthy server-side.
 */
export async function inspectDriveFolder(
    userId: string,
    folderId: string,
): Promise<InspectedDriveFolder> {
    if (!DRIVE_ID_SHAPE.test(folderId)) {
        throw unavailable("Choose a Google Drive folder");
    }
    const connection = await getGoogleConnectionStatus(userId);
    if (!connection) throw unavailable("Connect a Google account first");
    try {
        await getGoogleAccessToken(userId, {
            expectedSubject: connection.subject,
        });
    } catch (error) {
        if (error instanceof GoogleConnectionUnavailableError) {
            throw unavailable(error.message);
        }
        throw error;
    }
    const client = createDriveClient({
        driveId: null,
        getAccessToken: googleAccessTokenSource(userId, connection.subject),
        onUnauthorized: () => invalidateGoogleAccessToken(userId),
    });
    let item: Awaited<ReturnType<typeof client.getItem>>;
    try {
        item = await client.getItem(folderId);
    } catch (error) {
        if (
            error instanceof GoogleApiError &&
            (error.status === 403 || error.status === 404)
        ) {
            throw unavailable(
                "The chosen Google Drive folder is not available",
            );
        }
        throw error;
    }
    if (!item || item.trashed || item.mimeType !== DRIVE_FOLDER_MIME) {
        throw unavailable("The chosen Google Drive folder is not available");
    }
    if (!item.canAddChildren) {
        throw unavailable(
            "The connected Google account cannot add files to that folder",
        );
    }
    return {
        id: item.id,
        name: item.name,
        driveId: item.driveId,
        accountSubject: connection.subject,
    };
}
