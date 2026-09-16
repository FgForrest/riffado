/**
 * Regression tests for issue #217:
 *   Inline renaming of recording titles via PATCH /api/recordings/[id]
 *
 * Covers:
 *   1. Authenticated rename encrypts the title at rest and returns plaintext
 *   2. Empty / missing / overlong names are 400
 *   3. 404 for another user's recording / tombstoned row
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        DEFAULT_STORAGE_TYPE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        update: vi.fn(),
    },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({
        user: { id: "user-1" },
    }),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: vi.fn((value: string | null | undefined) =>
        typeof value === "string" ? value.replace(/^encrypted:/, "") : value,
    ),
    encryptText: vi.fn((value: string) => `encrypted:${value}`),
}));

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(),
}));

vi.mock("@/lib/export/document-sidecars", () => ({
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    sidecarKey: vi.fn(
        (storagePath: string, kind: "transcript" | "summary") =>
            `${storagePath.replace(/\.[^.]+$/, "")}.${kind}.md`,
    ),
}));

import { PATCH as patchRecording } from "@/app/api/recordings/[id]/route";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { encryptText } from "@/lib/encryption/fields";
import { ErrorCode } from "@/lib/errors";
import { refreshExistingRecordingSidecars } from "@/lib/export/document-sidecars";
import { MAX_RECORDING_TITLE_LENGTH } from "@/lib/recordings/filename";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { emitEvent } from "@/lib/webhooks/emit";

const storage = {
    exists: vi.fn().mockResolvedValue(false),
    copyFile: vi.fn().mockResolvedValue("copied"),
    deleteFile: vi.fn().mockResolvedValue(undefined),
};

function routeParams(id = "rec-1") {
    return { params: Promise.resolve({ id }) };
}

function patchRequest(body: unknown) {
    return new Request("http://localhost/api/recordings/rec-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

function mockUpdateReturning(row: unknown) {
    const whereSpy = vi.fn();
    const setPayloads: Record<string, unknown>[] = [];
    const set = vi.fn((values: Record<string, unknown>) => {
        setPayloads.push(values);
        const returned =
            "storageFilename" in values
                ? { storageFilename: values.storageFilename }
                : "storagePath" in values
                  ? { storagePath: values.storagePath }
                  : row;
        const returning = vi.fn().mockResolvedValue(returned ? [returned] : []);
        whereSpy.mockReturnValueOnce({ returning });
        return { values, where: whereSpy };
    });
    (db.update as Mock).mockReturnValue({ set });
    return { set, setPayloads, whereSpy };
}

function mockSelectReturning(result: unknown[]) {
    const limit = vi.fn().mockResolvedValue(result);
    const whereSpy = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where: whereSpy });
    (db.select as Mock).mockReturnValueOnce({ from });
    return { whereSpy };
}

function mockOwnedRecording(storagePath = "user-1/legacy.mp3") {
    return mockSelectReturning([
        { id: "rec-1", storagePath, storageFilename: null },
    ]);
}

/**
 * Walk a Drizzle SQL/expression tree looking for a reference to the
 * given column object. Same approach as the #56 delete-route tests.
 */
function exprReferencesColumn(
    expr: unknown,
    col: unknown,
    seen = new Set<unknown>(),
): boolean {
    if (expr == null || typeof expr !== "object") return false;
    if (expr === col) return true;
    if (seen.has(expr)) return false;
    seen.add(expr);
    for (const key of [
        "queryChunks",
        "sql",
        "left",
        "right",
        "value",
        "args",
        "chunks",
        "expr",
    ]) {
        const v = (expr as Record<string, unknown>)[key];
        if (Array.isArray(v)) {
            if (v.some((x) => exprReferencesColumn(x, col, seen))) return true;
        } else if (exprReferencesColumn(v, col, seen)) {
            return true;
        }
    }
    return false;
}

describe("PATCH /api/recordings/[id]", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (requireApiSession as unknown as Mock).mockResolvedValue({
            user: { id: "user-1" },
        });
        vi.mocked(createUserStorageProvider).mockResolvedValue(
            storage as never,
        );
        storage.exists.mockResolvedValue(false);
        storage.copyFile.mockResolvedValue("copied");
        storage.deleteFile.mockResolvedValue(undefined);
    });

    it("encrypts the new title at rest and returns plaintext", async () => {
        mockOwnedRecording();
        mockSelectReturning([]);
        mockSelectReturning([]);
        const { set } = mockUpdateReturning({
            id: "rec-1",
            filename: "encrypted:Q4 planning",
        });

        const response = await patchRecording(
            patchRequest({ filename: "  Q4 planning  " }),
            routeParams(),
        );

        expect(response.status).toBe(200);
        expect(encryptText).toHaveBeenCalledWith("Q4 planning");
        expect(set).toHaveBeenCalledWith(
            expect.objectContaining({
                filename: "encrypted:Q4 planning",
            }),
        );
        await expect(response.json()).resolves.toEqual({
            filename: "Q4 planning",
        });
        expect(emitEvent).toHaveBeenCalledWith(
            "recording.updated",
            "user-1",
            "rec-1",
        );
        expect(refreshExistingRecordingSidecars).toHaveBeenCalledWith(
            "user-1",
            "rec-1",
        );
    });

    it("rejects a missing or non-string filename", async () => {
        const response = await patchRecording(patchRequest({}), routeParams());
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.INVALID_INPUT,
        });
        expect(db.update).not.toHaveBeenCalled();
    });

    it("rejects an empty name after trimming", async () => {
        const response = await patchRecording(
            patchRequest({ filename: "   " }),
            routeParams(),
        );
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.INVALID_INPUT,
            error: "Name cannot be empty",
        });
        expect(db.update).not.toHaveBeenCalled();
    });

    it("rejects an overlong name", async () => {
        const response = await patchRecording(
            patchRequest({
                filename: "a".repeat(MAX_RECORDING_TITLE_LENGTH + 1),
            }),
            routeParams(),
        );
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.INVALID_INPUT,
        });
        expect(db.update).not.toHaveBeenCalled();
    });

    it("rejects a JSON null body", async () => {
        const response = await patchRecording(
            patchRequest(null),
            routeParams(),
        );
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.INVALID_INPUT,
        });
        expect(db.update).not.toHaveBeenCalled();
    });

    it("returns 404 when the row is missing or owned by another user", async () => {
        const { whereSpy } = mockSelectReturning([]);

        const response = await patchRecording(
            patchRequest({ filename: "New name" }),
            routeParams(),
        );

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.RECORDING_NOT_FOUND,
        });
        expect(emitEvent).not.toHaveBeenCalled();

        const whereExpr = whereSpy.mock.calls.at(-1)?.[0];
        expect(whereExpr).toBeDefined();
        expect(exprReferencesColumn(whereExpr, recordings.userId)).toBe(true);
        expect(exprReferencesColumn(whereExpr, recordings.id)).toBe(true);
        expect(exprReferencesColumn(whereExpr, recordings.deletedAt)).toBe(
            true,
        );
    });

    it("renames existing audio and document sidecars", async () => {
        mockOwnedRecording();
        mockSelectReturning([]);
        mockSelectReturning([]);
        mockUpdateReturning({
            id: "rec-1",
            filename: "encrypted:New title",
        });
        storage.exists.mockImplementation(async (key: string) =>
            key.includes("legacy"),
        );

        const response = await patchRecording(
            patchRequest({ filename: "New title" }),
            routeParams(),
        );

        expect(response.status).toBe(200);
        expect(storage.copyFile).toHaveBeenCalledTimes(3);
        expect(storage.copyFile).toHaveBeenCalledWith(
            "user-1/legacy.mp3",
            "user-1/New_title.mp3",
        );
        expect(storage.copyFile).toHaveBeenCalledWith(
            "user-1/legacy.transcript.md",
            "user-1/New_title.transcript.md",
        );
        expect(storage.copyFile).toHaveBeenCalledWith(
            "user-1/legacy.summary.md",
            "user-1/New_title.summary.md",
        );
        expect(storage.deleteFile).toHaveBeenCalledTimes(3);
    });

    it("does not remove a legacy source shared by another recording", async () => {
        mockOwnedRecording();
        mockSelectReturning([]);
        mockSelectReturning([{ id: "rec-2" }]);
        mockUpdateReturning({
            id: "rec-1",
            filename: "encrypted:New title",
        });
        storage.exists.mockImplementation(async (key: string) =>
            key.includes("legacy"),
        );

        const response = await patchRecording(
            patchRequest({ filename: "New title" }),
            routeParams(),
        );

        expect(response.status).toBe(200);
        expect(storage.copyFile).toHaveBeenCalledTimes(3);
        expect(storage.deleteFile).not.toHaveBeenCalled();
    });

    it("keeps the database unchanged when storage copying fails", async () => {
        mockOwnedRecording();
        mockSelectReturning([]);
        mockSelectReturning([]);
        const { setPayloads } = mockUpdateReturning({
            id: "rec-1",
            filename: "encrypted:New title",
        });
        storage.exists.mockImplementation(async (key: string) =>
            key.includes("legacy"),
        );
        storage.copyFile.mockRejectedValueOnce(new Error("disk full"));

        const response = await patchRecording(
            patchRequest({ filename: "New title" }),
            routeParams(),
        );

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.STORAGE_ERROR,
        });
        expect(setPayloads.some((payload) => "filename" in payload)).toBe(
            false,
        );
        expect(emitEvent).not.toHaveBeenCalled();
    });
});
