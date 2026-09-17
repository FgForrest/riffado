import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        transaction: vi.fn(),
    },
}));

import { db } from "@/db";
import {
    recordingFolderAssignments,
    recordingFolders,
    recordings,
} from "@/db/schema";
import { encryptText } from "@/lib/encryption/fields";
import {
    addRecordingToFolder,
    deleteFolder,
    moveFolder,
    removeRecordingFromFolder,
} from "@/lib/folders/folders";
import { exprBindsValue, exprReferencesColumn } from "../fixtures/drizzle-expr";

function selectAnswer(rows: unknown[], wheres: unknown[]) {
    return {
        from: vi.fn().mockReturnValue({
            where: vi.fn((expression: unknown) => {
                wheres.push(expression);
                return { limit: vi.fn().mockResolvedValue(rows) };
            }),
        }),
    };
}

describe("folder ownership", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("scopes both sides before assigning a recording to a folder", async () => {
        const wheres: unknown[] = [];
        (db.select as Mock)
            .mockReturnValueOnce(selectAnswer([{ id: "rec-1" }], wheres))
            .mockReturnValueOnce(
                selectAnswer([{ id: "folder-1", kind: "custom" }], wheres),
            );
        const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
        (db.insert as Mock).mockReturnValue({
            values: vi.fn().mockReturnValue({ onConflictDoNothing }),
        });

        await addRecordingToFolder({
            userId: "user-1",
            recordingId: "rec-1",
            folderId: "folder-1",
        });

        expect(exprReferencesColumn(wheres[0], recordings.userId)).toBe(true);
        expect(exprReferencesColumn(wheres[0], recordings.id)).toBe(true);
        expect(exprBindsValue(wheres[0], "user-1")).toBe(true);
        expect(exprReferencesColumn(wheres[1], recordingFolders.userId)).toBe(
            true,
        );
        expect(exprReferencesColumn(wheres[1], recordingFolders.id)).toBe(true);
        expect(exprBindsValue(wheres[1], "user-1")).toBe(true);
        expect(onConflictDoNothing).toHaveBeenCalledOnce();
    });

    it("will not assign when either owned resource is missing", async () => {
        const wheres: unknown[] = [];
        (db.select as Mock)
            .mockReturnValueOnce(selectAnswer([], wheres))
            .mockReturnValueOnce(
                selectAnswer([{ id: "folder-1", kind: "custom" }], wheres),
            );

        await expect(
            addRecordingToFolder({
                userId: "user-1",
                recordingId: "rec-theirs",
                folderId: "folder-1",
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(db.insert).not.toHaveBeenCalled();
    });

    it("scopes folder deletion and assignment removal by userId", async () => {
        const deleteWheres: unknown[] = [];
        (db.delete as Mock)
            .mockReturnValueOnce({
                where: vi.fn((expression: unknown) => {
                    deleteWheres.push(expression);
                    return {
                        returning: vi
                            .fn()
                            .mockResolvedValue([{ id: "folder-1" }]),
                    };
                }),
            })
            .mockReturnValueOnce({
                where: vi.fn((expression: unknown) => {
                    deleteWheres.push(expression);
                    return Promise.resolve();
                }),
            });

        await deleteFolder("user-1", "folder-1");
        await removeRecordingFromFolder({
            userId: "user-1",
            recordingId: "rec-1",
            folderId: "folder-1",
        });

        expect(
            exprReferencesColumn(deleteWheres[0], recordingFolders.userId),
        ).toBe(true);
        expect(exprBindsValue(deleteWheres[0], "custom")).toBe(true);
        expect(
            exprReferencesColumn(
                deleteWheres[1],
                recordingFolderAssignments.userId,
            ),
        ).toBe(true);
        expect(
            exprReferencesColumn(
                deleteWheres[1],
                recordingFolderAssignments.recordingId,
            ),
        ).toBe(true);
        expect(
            exprReferencesColumn(
                deleteWheres[1],
                recordingFolderAssignments.folderId,
            ),
        ).toBe(true);
    });

    it("persists sibling order and scopes every reorder query by userId", async () => {
        const selectWheres: unknown[] = [];
        const updateWheres: unknown[] = [];
        const updates: Array<{ parentId: string; sortOrder: number }> = [];
        const folderRows = [
            {
                id: "private",
                parentId: null,
                name: encryptText("Private"),
                kind: "private" as const,
                sortOrder: 0,
            },
            {
                id: "first",
                parentId: "private",
                name: encryptText("First"),
                kind: "custom" as const,
                sortOrder: 0,
            },
            {
                id: "last",
                parentId: "private",
                name: encryptText("Last"),
                kind: "custom" as const,
                sortOrder: 1000,
            },
        ];
        const tx = {
            select: vi.fn().mockReturnValue({
                from: vi.fn().mockReturnValue({
                    where: vi.fn((expression: unknown) => {
                        selectWheres.push(expression);
                        return Promise.resolve(folderRows);
                    }),
                }),
            }),
            update: vi.fn().mockReturnValue({
                set: vi.fn(
                    (values: { parentId: string; sortOrder: number }) => {
                        updates.push(values);
                        return {
                            where: vi.fn((expression: unknown) => {
                                updateWheres.push(expression);
                                return Promise.resolve();
                            }),
                        };
                    },
                ),
            }),
        };
        (db.transaction as Mock).mockImplementation(
            (callback: (transaction: typeof tx) => Promise<unknown>) =>
                callback(tx),
        );

        const moved = await moveFolder({
            userId: "user-1",
            folderId: "last",
            parentId: "private",
            beforeId: "first",
        });

        expect(moved.sortOrder).toBe(0);
        expect(updates.map((update) => update.sortOrder)).toEqual([0, 1000]);
        expect(
            exprReferencesColumn(selectWheres[0], recordingFolders.userId),
        ).toBe(true);
        for (const where of updateWheres) {
            expect(exprReferencesColumn(where, recordingFolders.userId)).toBe(
                true,
            );
            expect(exprBindsValue(where, "user-1")).toBe(true);
        }
    });
});
