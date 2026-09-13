import { beforeEach, describe, expect, it, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
    envMock: {
        DEFAULT_STORAGE_TYPE: "local" as "local" | "s3",
        LOCAL_STORAGE_PATH: "./storage",
        BACKUP_STORAGE_PATH: undefined as string | undefined,
        S3_ENDPOINT: undefined as string | undefined,
        S3_BUCKET: "bucket",
        S3_REGION: "eu-central-1",
        S3_ACCESS_KEY_ID: "key",
        S3_SECRET_ACCESS_KEY: "secret",
    },
}));

vi.mock("@/lib/env", () => ({ env: envMock }));

import {
    backupStorageType,
    createBackupStorageProvider,
    LocalStorage,
    S3Storage,
} from "@/lib/storage/factory";

describe("backup storage destination", () => {
    beforeEach(() => {
        envMock.DEFAULT_STORAGE_TYPE = "local";
        envMock.BACKUP_STORAGE_PATH = undefined;
    });

    it("falls back to the instance storage when no backup path is set", () => {
        expect(backupStorageType()).toBe("local");
        expect(createBackupStorageProvider()).toBeInstanceOf(LocalStorage);

        envMock.DEFAULT_STORAGE_TYPE = "s3";
        expect(backupStorageType()).toBe("s3");
        expect(createBackupStorageProvider()).toBeInstanceOf(S3Storage);
    });

    it("sends archives to the dedicated path when one is configured", () => {
        envMock.BACKUP_STORAGE_PATH = "/mnt/backups";

        expect(backupStorageType()).toBe("local");
        expect(createBackupStorageProvider()).toBeInstanceOf(LocalStorage);
    });

    it("overrides an S3 instance backend too", () => {
        // The point of a dedicated backup volume is that it is somewhere
        // else. If S3 kept winning here, setting the path on an
        // S3-backed instance would silently do nothing -- and the
        // download route would then redirect to a signed URL for an
        // object that was never uploaded.
        envMock.DEFAULT_STORAGE_TYPE = "s3";
        envMock.BACKUP_STORAGE_PATH = "/mnt/backups";

        expect(backupStorageType()).toBe("local");
        expect(createBackupStorageProvider()).toBeInstanceOf(LocalStorage);
    });
});
