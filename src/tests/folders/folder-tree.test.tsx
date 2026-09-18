// @vitest-environment jsdom

import {
    cleanup,
    createEvent,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { FolderTree } from "@/components/dashboard/folder-tree";
import { RecordingListToolbar } from "@/components/dashboard/recording-list-toolbar";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const folders: RecordingFolder[] = [
    {
        id: "private",
        parentId: null,
        name: "Private",
        kind: "private",
        sortOrder: 0,
    },
    {
        id: "public",
        parentId: null,
        name: "Public",
        kind: "public",
        sortOrder: 1000,
    },
    {
        id: "meetings",
        parentId: "private",
        name: "Meetings",
        kind: "custom",
        sortOrder: 0,
    },
    {
        id: "planning",
        parentId: "meetings",
        name: "Planning",
        kind: "custom",
        sortOrder: 0,
    },
    {
        id: "archive",
        parentId: "meetings",
        name: "Archive",
        kind: "custom",
        sortOrder: 1000,
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

    it("shows fixed roots and distinct subtree folder counts", () => {
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
                    onAssignRecording={vi.fn()}
                />
            </ConfirmDialogProvider>,
        );

        expect(
            screen.getByRole("button", { name: "Private, 2 recordings" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Meetings, 2 recordings" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Planning, 1 recording" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Public, 0 recordings" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Public, 0 recordings" })
                .previousElementSibling?.tagName,
        ).toBe("SPAN");
    });

    it("reorders folders within the same parent by drag and drop", () => {
        const onMoveFolder = vi.fn().mockResolvedValue(undefined);
        render(
            <ConfirmDialogProvider>
                <FolderTree
                    folders={folders}
                    assignments={[]}
                    recordings={recordings}
                    selectedFolderId={null}
                    onRecent={vi.fn()}
                    onSelectFolder={vi.fn()}
                    onCreateFolder={vi.fn()}
                    onRenameFolder={vi.fn()}
                    onMoveFolder={onMoveFolder}
                    onDeleteFolder={vi.fn()}
                    onAssignRecording={vi.fn()}
                />
            </ConfirmDialogProvider>,
        );

        const planning = screen.getByRole("button", {
            name: "Planning, 0 recordings",
        });
        const archive = screen.getByRole("button", {
            name: "Archive, 0 recordings",
        });
        archive.getBoundingClientRect = () =>
            ({ top: 0, height: 40 }) as DOMRect;
        const dataTransfer = {
            effectAllowed: "none",
            dropEffect: "none",
            setData: vi.fn(),
            getData: vi.fn().mockReturnValue("planning"),
        };

        fireEvent.dragStart(planning, { dataTransfer });
        const dragOver = createEvent.dragOver(archive);
        Object.defineProperties(dragOver, {
            clientY: { value: 5 },
            dataTransfer: { value: dataTransfer },
        });
        fireEvent(archive, dragOver);
        const drop = createEvent.drop(archive);
        Object.defineProperties(drop, {
            clientY: { value: 5 },
            dataTransfer: { value: dataTransfer },
        });
        fireEvent(archive, drop);

        expect(onMoveFolder).toHaveBeenCalledWith(
            "planning",
            "meetings",
            "archive",
        );
    });

    it("assigns a dropped recording to a folder", () => {
        const onAssignRecording = vi.fn().mockResolvedValue(undefined);
        render(
            <ConfirmDialogProvider>
                <FolderTree
                    folders={folders}
                    assignments={[]}
                    recordings={recordings}
                    selectedFolderId={null}
                    onRecent={vi.fn()}
                    onSelectFolder={vi.fn()}
                    onCreateFolder={vi.fn()}
                    onRenameFolder={vi.fn()}
                    onMoveFolder={vi.fn()}
                    onDeleteFolder={vi.fn()}
                    onAssignRecording={onAssignRecording}
                />
            </ConfirmDialogProvider>,
        );

        const meetings = screen.getByRole("button", {
            name: "Meetings, 0 recordings",
        });
        const dataTransfer = {
            effectAllowed: "copy",
            dropEffect: "none",
            types: ["application/x-riffado-recording"],
            setData: vi.fn(),
            getData: vi
                .fn()
                .mockImplementation((type: string) =>
                    type === "application/x-riffado-recording" ? "rec-1" : "",
                ),
        };

        fireEvent.dragOver(meetings, { dataTransfer });
        expect(dataTransfer.dropEffect).toBe("copy");
        fireEvent.drop(meetings, { dataTransfer });

        expect(onAssignRecording).toHaveBeenCalledWith("rec-1", "meetings");
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
                    onAssignRecording={vi.fn()}
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
