import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: {} }));

import { DriveTargetLostError } from "@/lib/folder-exports/drive-provider";
import { parseSaveFolderExportInput } from "@/lib/folder-exports/input";
import { isExportErrorRetryable } from "@/lib/folder-exports/retry";
import {
    GoogleApiError,
    GoogleConnectionUnavailableError,
} from "@/lib/integrations/google/errors";

const flags = {
    exportAudio: true,
    exportTranscript: false,
    exportSummary: true,
};

describe("folder export request body", () => {
    it("accepts a filesystem export", () => {
        expect(
            parseSaveFolderExportInput({
                provider: "filesystem",
                targetPath: "team",
                ...flags,
            }),
        ).toEqual({ provider: "filesystem", targetPath: "team", ...flags });
    });

    it("accepts a Google Drive export with its formats", () => {
        expect(
            parseSaveFolderExportInput({
                provider: "google-drive",
                rootFolderId: "folder1",
                transcriptFormat: "both",
                summaryFormat: "google_doc",
                targetPath: "ignored",
                ...flags,
            }),
        ).toEqual({
            provider: "google-drive",
            rootFolderId: "folder1",
            transcriptFormat: "both",
            summaryFormat: "google_doc",
            ...flags,
        });
    });

    it("rejects anything else", () => {
        for (const body of [
            null,
            { provider: "s3", targetPath: "x", ...flags },
            { provider: "filesystem", ...flags },
            { provider: "google-drive", rootFolderId: "f", ...flags },
            {
                provider: "google-drive",
                rootFolderId: "f",
                transcriptFormat: "pdf",
                summaryFormat: "markdown",
                ...flags,
            },
            { provider: "filesystem", targetPath: "x", exportAudio: "yes" },
        ]) {
            expect(() => parseSaveFolderExportInput(body)).toThrow(
                "Invalid export configuration",
            );
        }
    });
});

describe("folder export retries", () => {
    it("retries throttling and outages, not what needs the user", () => {
        expect(
            isExportErrorRetryable(new GoogleApiError(429, null, "slow down")),
        ).toBe(true);
        expect(
            isExportErrorRetryable(
                new GoogleApiError(403, "userRateLimitExceeded", "slow down"),
            ),
        ).toBe(true);
        expect(
            isExportErrorRetryable(new GoogleApiError(401, null, "expired")),
        ).toBe(true);
        expect(
            isExportErrorRetryable(
                new GoogleApiError(403, "insufficientFilePermissions", "no"),
            ),
        ).toBe(false);
        expect(
            isExportErrorRetryable(
                new GoogleConnectionUnavailableError("needs_reconnect"),
            ),
        ).toBe(false);
        expect(isExportErrorRetryable(new DriveTargetLostError("gone"))).toBe(
            false,
        );
        expect(isExportErrorRetryable(new Error("fetch failed"))).toBe(true);
    });
});
