import { env } from "../env";
import { LocalStorage } from "./local-storage";
import { S3Storage } from "./s3-storage";
import type { S3Config, StorageProvider, StorageType } from "./types";

/** Build the instance-level storage provider from env. */
export function createStorageProvider(): StorageProvider {
    const storageType = env.DEFAULT_STORAGE_TYPE;

    if (storageType === "local") {
        return new LocalStorage();
    }

    if (storageType === "s3") {
        const s3Config: S3Config = {
            endpoint: env.S3_ENDPOINT,
            bucket: env.S3_BUCKET || "",
            region: env.S3_REGION || "",
            accessKeyId: env.S3_ACCESS_KEY_ID || "",
            secretAccessKey: env.S3_SECRET_ACCESS_KEY || "",
        };

        if (
            !s3Config.bucket ||
            !s3Config.region ||
            !s3Config.accessKeyId ||
            !s3Config.secretAccessKey
        ) {
            throw new Error(
                "S3 storage is configured but required environment variables are missing (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)",
            );
        }

        return new S3Storage(s3Config);
    }

    throw new Error(`Unsupported storage type: ${storageType}`);
}

export async function createUserStorageProvider(
    _userId: string,
): Promise<StorageProvider> {
    return createStorageProvider();
}

/**
 * Which backend backup archives live on. Differs from
 * `DEFAULT_STORAGE_TYPE` whenever `BACKUP_STORAGE_PATH` is set, which is
 * why the download route has to ask this rather than assume the two
 * match -- a signed-URL redirect for a file sitting on local disk would
 * 404, and streaming an S3 object through the app when it could redirect
 * wastes the app server's bandwidth.
 */
export function backupStorageType(): StorageType {
    return env.BACKUP_STORAGE_PATH ? "local" : env.DEFAULT_STORAGE_TYPE;
}

/**
 * Storage for full-data backup archives. Falls back to the instance's
 * normal storage, so an operator who sets nothing keeps today's
 * behaviour exactly.
 *
 * A dedicated path is worth setting: a backup written beside the data it
 * backs up survives neither the disk failing nor the folder being
 * deleted, and on a local install it also means each scheduled archive
 * roughly doubles the size of the folder holding the recordings.
 */
export function createBackupStorageProvider(): StorageProvider {
    if (env.BACKUP_STORAGE_PATH) {
        return new LocalStorage(env.BACKUP_STORAGE_PATH);
    }
    return createStorageProvider();
}

export { LocalStorage } from "./local-storage";
export { S3Storage } from "./s3-storage";
export * from "./types";
