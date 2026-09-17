// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { FolderRecordingPane } from "@/components/dashboard/folder-recording-pane";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

const privateRoot: RecordingFolder = {
    id: "private",
    parentId: null,
    name: "Private",
    kind: "private",
    sortOrder: 0,
};
const meetings: RecordingFolder = {
    id: "meetings",
    parentId: "private",
    name: "Meetings",
    kind: "custom",
    sortOrder: 0,
};
const planning: RecordingFolder = {
    id: "planning",
    parentId: "meetings",
    name: "Planning",
    kind: "custom",
    sortOrder: 0,
};
const recordings: Recording[] = [
    {
        id: "rec-direct",
        filename: "Direct meeting",
        duration: 60_000,
        filesize: 1000,
        startTime: new Date(0).toISOString(),
        deviceSn: "local",
    },
    {
        id: "rec-child",
        filename: "Child meeting",
        duration: 120_000,
        filesize: 2000,
        startTime: new Date(1).toISOString(),
        deviceSn: "local",
    },
];

function renderPane(folder: RecordingFolder) {
    render(
        <ConfirmDialogProvider>
            <FolderRecordingPane
                folder={folder}
                folders={[privateRoot, meetings, planning]}
                assignments={[
                    { recordingId: "rec-direct", folderId: "meetings" },
                    { recordingId: "rec-child", folderId: "planning" },
                ]}
                recordings={recordings}
                dateTimeFormat="relative"
                onSelectRecording={vi.fn()}
                onRenameFolder={vi.fn()}
                onDeleteFolder={vi.fn()}
                hiddenOnMobile={false}
                onBackToFolders={vi.fn()}
            />
        </ConfirmDialogProvider>,
    );
}

describe("folder recording pane", () => {
    afterEach(cleanup);

    it("lists only recordings assigned directly to a custom folder", () => {
        renderPane(meetings);
        expect(screen.getByText("Direct meeting")).toBeTruthy();
        expect(screen.queryByText("Child meeting")).toBeNull();
        expect(screen.getByText("1 recording")).toBeTruthy();
    });

    it("lists every recording in the Private root", () => {
        renderPane(privateRoot);
        expect(screen.getByText("Direct meeting")).toBeTruthy();
        expect(screen.getByText("Child meeting")).toBeTruthy();
        expect(screen.getByText("2 recordings")).toBeTruthy();
    });

    it("renders synchronization as unavailable in this phase", () => {
        renderPane(meetings);
        expect(
            (
                screen.getByRole("button", {
                    name: "Synchronize",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
    });

    it("sorts the recording table by every displayed column", () => {
        renderPane(privateRoot);

        expect(
            screen.getByRole("button", { name: "Sort by Title" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: "Sort by Date, descending",
            }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Sort by Duration" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Sort by Size" }),
        ).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Sort by Title" }));
        fireEvent.click(
            screen.getByRole("button", {
                name: "Sort by Title, ascending",
            }),
        );
        const rows = screen.getAllByRole("button", { name: /^Open / });
        expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
            "Open Direct meeting",
            "Open Child meeting",
        ]);
    });
});
