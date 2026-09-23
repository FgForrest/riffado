import { env } from "@/lib/env";
import {
    getGoogleAccessToken,
    googleAccessTokenSource,
    invalidateGoogleAccessToken,
} from "@/lib/integrations/google/connection";
import { createDriveClient } from "@/lib/integrations/google/drive-client";
import { DbDriveNodeStore } from "./drive-nodes";
import { DriveExportProvider } from "./drive-provider";
import { FilesystemExportProvider } from "./filesystem-provider";
import type { ExportTarget } from "./target";
import type { ExportProvider } from "./types";

/**
 * The provider writing `target`. A Drive export fails here, before any
 * work, when its Google account is not usable.
 */
export async function createExportProvider(
    target: ExportTarget,
): Promise<ExportProvider> {
    switch (target.provider) {
        case "filesystem":
            return new FilesystemExportProvider(
                env.FILESYSTEM_EXPORT_ROOT ?? "",
            );
        case "google-drive": {
            const drive = target.googleDrive;
            if (!drive) throw new Error("Google Drive export has no settings");
            await getGoogleAccessToken(target.userId, {
                expectedSubject: drive.accountSubject,
            });
            return new DriveExportProvider({
                exportId: target.id,
                rootFolderId: drive.rootFolderId,
                client: createDriveClient({
                    driveId: drive.driveId,
                    getAccessToken: googleAccessTokenSource(
                        target.userId,
                        drive.accountSubject,
                    ),
                    onUnauthorized: () =>
                        invalidateGoogleAccessToken(target.userId),
                }),
                nodes: new DbDriveNodeStore(target.userId, target.id),
            });
        }
    }
}
