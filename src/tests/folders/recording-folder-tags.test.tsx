// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingFolderTags } from "@/components/recordings/recording-folder-tags";
import type { RecordingFolder } from "@/types/folder";

const folder: RecordingFolder = {
    id: "meetings",
    parentId: "private",
    name: "Meetings",
    kind: "custom",
    sortOrder: 0,
};

describe("recording folder tags", () => {
    afterEach(cleanup);

    it("opens the assigned folder and removes only that assignment", async () => {
        const onSelectFolder = vi.fn();
        const onRemove = vi.fn().mockResolvedValue(undefined);
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[folder]}
                assignments={[{ recordingId: "rec-1", folderId: "meetings" }]}
                onSelectFolder={onSelectFolder}
                onAdd={vi.fn()}
                onRemove={onRemove}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Meetings" }));
        expect(onSelectFolder).toHaveBeenCalledWith(folder);

        fireEvent.click(
            screen.getByRole("button", { name: "Remove from Meetings" }),
        );
        expect(onRemove).toHaveBeenCalledWith("rec-1", "meetings");
    });

    it("does not offer the implicit Private root as an assignment", () => {
        render(
            <RecordingFolderTags
                recordingId="rec-1"
                folders={[
                    {
                        id: "private",
                        parentId: null,
                        name: "Private",
                        kind: "private",
                        sortOrder: 0,
                    },
                ]}
                assignments={[]}
                onSelectFolder={vi.fn()}
                onAdd={vi.fn()}
                onRemove={vi.fn()}
            />,
        );

        expect(screen.queryByRole("button", { name: "Private" })).toBeNull();
    });
});
