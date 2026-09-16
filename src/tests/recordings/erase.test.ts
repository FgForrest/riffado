import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));

import {
    deleteRecordingStorageArtifacts,
    storageKeysForErase,
} from "@/lib/recordings/erase";
import type { StorageProvider } from "@/lib/storage/types";

function storageWithDelete(deleteFile: StorageProvider["deleteFile"]) {
    return { deleteFile } as StorageProvider;
}

describe("recording artifact erasure", () => {
    it("covers legacy and provider-scoped transcript exports", () => {
        expect(
            storageKeysForErase("users/u/Meeting.ogg", "transcript"),
        ).toEqual([
            "users/u/Meeting.transcript.md",
            "users/u/Meeting.plaud.transcript.md",
            "users/u/Meeting.custom.transcript.md",
            "users/u/Meeting.mixed.transcript.md",
        ]);
    });

    it("deletes audio plus every transcript and summary sidecar", async () => {
        const deleteFile = vi.fn().mockResolvedValue(undefined);

        await deleteRecordingStorageArtifacts(
            storageWithDelete(deleteFile),
            "users/u/Meeting.ogg",
            "all",
        );

        expect(deleteFile).toHaveBeenCalledTimes(9);
        expect(deleteFile).toHaveBeenCalledWith("users/u/Meeting.ogg");
        expect(deleteFile).toHaveBeenCalledWith(
            "users/u/Meeting.plaud.summary.md",
        );
        expect(deleteFile).toHaveBeenCalledWith(
            "users/u/Meeting.custom.transcript.md",
        );
    });

    it("treats already-absent exports as an idempotent success", async () => {
        const missing = Object.assign(new Error("no such file or directory"), {
            code: "ENOENT",
        });
        const deleteFile = vi.fn().mockRejectedValue(missing);

        await expect(
            deleteRecordingStorageArtifacts(
                storageWithDelete(deleteFile),
                "users/u/Meeting.ogg",
                "summary",
            ),
        ).resolves.toBeUndefined();
        expect(deleteFile).toHaveBeenCalledTimes(4);
    });

    it("surfaces real storage failures so cleanup can be retried", async () => {
        const deleteFile = vi
            .fn()
            .mockRejectedValue(new Error("S3 access denied"));

        await expect(
            deleteRecordingStorageArtifacts(
                storageWithDelete(deleteFile),
                "users/u/Meeting.ogg",
                "audio",
            ),
        ).rejects.toThrow("S3 access denied");
    });
});
