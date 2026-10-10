import { decryptBuffer, encryptBuffer } from "@/lib/encryption";
import { createUserStorageProvider } from "@/lib/storage/factory";

/**
 * Where a mail's raw message is kept: under `mail/`, by owner and item,
 * never by subject or sender. Nothing else in storage is named like this,
 * so no audio reconciliation or sweep ever touches it.
 */
export function rawMailKey(ownerUserId: string, itemId: string): string {
    return `mail/${ownerUserId}/${itemId}.eml.enc`;
}

/** Stores a raw message encrypted; returns its key. */
export async function storeRawMail(
    ownerUserId: string,
    itemId: string,
    raw: Buffer,
): Promise<string> {
    const key = rawMailKey(ownerUserId, itemId);
    const storage = await createUserStorageProvider(ownerUserId);
    await storage.uploadFile(
        key,
        encryptBuffer(raw),
        "application/octet-stream",
    );
    return key;
}

/** The raw message stored at `key`, decrypted. */
export async function readRawMail(
    ownerUserId: string,
    key: string,
): Promise<Buffer> {
    if (!key.startsWith(`mail/${ownerUserId}/`)) {
        throw new Error("Not this owner's mail");
    }
    const storage = await createUserStorageProvider(ownerUserId);
    return decryptBuffer(await storage.downloadFile(key));
}

/** Deletes a stored raw message; a missing one is no error. */
export async function deleteRawMail(
    ownerUserId: string,
    key: string,
): Promise<void> {
    if (!key.startsWith(`mail/${ownerUserId}/`)) return;
    const storage = await createUserStorageProvider(ownerUserId);
    try {
        await storage.deleteFile(key);
    } catch (error) {
        if (!(await storage.exists(key))) return;
        throw error;
    }
}
