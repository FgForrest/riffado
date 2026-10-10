import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

function getEncryptionKey(): Buffer {
    const keyHex = env.ENCRYPTION_KEY;
    if (!keyHex || keyHex.length !== 64) {
        throw new Error(
            "ENCRYPTION_KEY must be set and be exactly 64 hex characters (32 bytes)",
        );
    }
    return Buffer.from(keyHex, "hex");
}

/** AES-256-GCM encrypt. Returns `iv:authTag:ciphertext` (hex). */
export function encrypt(plaintext: string): string {
    try {
        const key = getEncryptionKey();
        const iv = randomBytes(IV_LENGTH);
        const cipher = createCipheriv(ALGORITHM, key, iv);

        let encrypted = cipher.update(plaintext, "utf8", "hex");
        encrypted += cipher.final("hex");

        const authTag = cipher.getAuthTag();
        return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
    } catch (error) {
        throw new Error(
            `Encryption failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/** Decrypt a value produced by `encrypt`. */
export function decrypt(ciphertext: string): string {
    try {
        const key = getEncryptionKey();

        const parts = ciphertext.split(":");
        if (parts.length !== 3) {
            throw new Error("Invalid ciphertext format");
        }

        const [ivHex, authTagHex, encryptedHex] = parts;

        const iv = Buffer.from(ivHex, "hex");
        const authTag = Buffer.from(authTagHex, "hex");
        const encrypted = Buffer.from(encryptedHex, "hex");

        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString("utf8");
    } catch (error) {
        throw new Error(
            `Decryption failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

export function encryptJSON<T>(data: T): string {
    return encrypt(JSON.stringify(data));
}

export function decryptJSON<T>(ciphertext: string): T {
    const decrypted = decrypt(ciphertext);
    return JSON.parse(decrypted) as T;
}

/** Generate a random AES-256 key as hex. */
export function generateEncryptionKey(): string {
    return randomBytes(KEY_LENGTH).toString("hex");
}

const BUFFER_MAGIC = Buffer.from("RFE1");
const BUFFER_IV_LENGTH = 12;
const BUFFER_TAG_LENGTH = 16;

/**
 * AES-256-GCM over bytes, for files (a raw mail): `RFE1`, a 12-byte IV, the
 * 16-byte tag, then the ciphertext. Binary, so a 36 MB message stays one.
 */
export function encryptBuffer(plaintext: Buffer): Buffer {
    const iv = randomBytes(BUFFER_IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([BUFFER_MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

/** Decrypts what `encryptBuffer` produced; throws on any tampering. */
export function decryptBuffer(ciphertext: Buffer): Buffer {
    const header = BUFFER_MAGIC.length + BUFFER_IV_LENGTH + BUFFER_TAG_LENGTH;
    if (
        ciphertext.length < header ||
        !ciphertext.subarray(0, BUFFER_MAGIC.length).equals(BUFFER_MAGIC)
    ) {
        throw new Error("Decryption failed: not an encrypted file");
    }
    const iv = ciphertext.subarray(
        BUFFER_MAGIC.length,
        BUFFER_MAGIC.length + BUFFER_IV_LENGTH,
    );
    const tag = ciphertext.subarray(
        BUFFER_MAGIC.length + BUFFER_IV_LENGTH,
        header,
    );
    const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
        decipher.update(ciphertext.subarray(header)),
        decipher.final(),
    ]);
}
