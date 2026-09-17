// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { FolderTree } from "@/components/dashboard/folder-tree";
import { RecordingListToolbar } from "@/components/dashboard/recording-list-toolbar";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const folders: RecordingFolder[] = [
    { id: "private", parentId: null, name: "Private", kind: "private" },
    { id: "public", parentId: null, name: "Public", kind: "public" },
    {
        id: "meetings",
        parentId: "private",
        name: "Meetings",
        kind: "custom",
    },
    {
        id: "planning",
        parentId: "meetings",
        name: "Planning",
        kind: "custom",
    },
];

const recordings: Recording[] = [
    {
        id: "rec-1",
        filename: "One",
        duration: 1000,
        filesize: 100,
        startTime: new Date(0).toISOString(),
        deviceSn: "local",
    },
    {
        id: "rec-2",
        filename: "Two",
        duration: 1000,
        filesize: 100,
        startTime: new Date(1).toISOString(),
        deviceSn: "local",
    },
];

describe("folder navigation", () => {
    afterEach(cleanup);

    it("shows fixed roots and direct-only folder counts", () => {
        render(
            <ConfirmDialogProvider>
                <FolderTree
                    folders={folders}
                    assignments={[
                        { recordingId: "rec-1", folderId: "meetings" },
                        { recordingId: "rec-2", folderId: "planning" },
                    ]}
                    recordings={recordings}
                    selectedFolderId={null}
                    onRecent={vi.fn()}
                    onSelectFolder={vi.fn()}
                    onCreateFolder={vi.fn()}
                    onRenameFolder={vi.fn()}
                    onMoveFolder={vi.fn()}
                    onDeleteFolder={vi.fn()}
                />
            </ConfirmDialogProvider>,
        );

        expect(
            screen.getByRole("button", { name: "Private, 2 recordings" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Meetings, 1 recording" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Planning, 1 recording" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Public, 0 recordings" }),
        ).toBeTruthy();
    });

    it("returns to the recent-recordings mode", () => {
        const onRecent = vi.fn();
        render(
            <ConfirmDialogProvider>
                <FolderTree
                    folders={folders}
                    assignments={[]}
                    recordings={recordings}
                    selectedFolderId={null}
                    onRecent={onRecent}
                    onSelectFolder={vi.fn()}
                    onCreateFolder={vi.fn()}
                    onRenameFolder={vi.fn()}
                    onMoveFolder={vi.fn()}
                    onDeleteFolder={vi.fn()}
                />
            </ConfirmDialogProvider>,
        );

        fireEvent.click(screen.getByRole("button", { name: "Recent" }));
        expect(onRecent).toHaveBeenCalledOnce();
    });

    it("replaces density controls with Organize in the recent toolbar", () => {
        const onOrganize = vi.fn();
        render(
            <RecordingListToolbar
                query=""
                onQueryChange={vi.fn()}
                onEnterSelectFirst={vi.fn()}
                searchRef={{ current: null }}
                filteredCount={2}
                totalCount={2}
                sortOrder="newest"
                onSortOrderChange={vi.fn()}
                onOrganize={onOrganize}
            />,
        );

        expect(screen.queryByRole("button", { name: "Density" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Organize" }));
        expect(onOrganize).toHaveBeenCalledOnce();
    });
});
