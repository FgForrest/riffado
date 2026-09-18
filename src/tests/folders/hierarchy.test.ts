import { describe, expect, it } from "vitest";
import {
    applicableExportConfigurationIds,
    canonicalFolderIds,
    effectiveRecordingCounts,
    exportPlacementFolderIds,
    organizationForDeployment,
    recordingIdsVisibleInFolder,
    relativeFolderPath,
} from "@/lib/folders/hierarchy";
import type { RecordingFolder } from "@/types/folder";

const privateRoot: RecordingFolder = {
    id: "private",
    parentId: null,
    name: "Private",
    kind: "private",
    sortOrder: 0,
};
const publicRoot: RecordingFolder = {
    id: "public",
    parentId: null,
    name: "Public",
    kind: "public",
    sortOrder: 1000,
};
const meetings: RecordingFolder = {
    id: "meetings",
    parentId: "private",
    name: "Meetings",
    kind: "custom",
    sortOrder: 0,
};
const weekly: RecordingFolder = {
    id: "weekly",
    parentId: "meetings",
    name: "Weekly",
    kind: "custom",
    sortOrder: 0,
};
const team: RecordingFolder = {
    id: "team",
    parentId: "meetings",
    name: "Team",
    kind: "custom",
    sortOrder: 1000,
};
const published: RecordingFolder = {
    id: "published",
    parentId: "public",
    name: "Published",
    kind: "custom",
    sortOrder: 0,
};

describe("folder hierarchy", () => {
    it("derives visibility through multiple ancestors", () => {
        const folders = [
            privateRoot,
            publicRoot,
            meetings,
            weekly,
            team,
            published,
        ];
        const assignments = [{ recordingId: "r1", folderId: "weekly" }];
        expect([
            ...recordingIdsVisibleInFolder(folders, assignments, weekly, [
                "r1",
            ]),
        ]).toEqual(["r1"]);
        expect([
            ...recordingIdsVisibleInFolder(folders, assignments, meetings, [
                "r1",
            ]),
        ]).toEqual(["r1"]);
        expect([
            ...recordingIdsVisibleInFolder(folders, assignments, privateRoot, [
                "r1",
            ]),
        ]).toEqual(["r1"]);
    });

    it("changes effective visibility immediately when a folder moves", () => {
        const movedWeekly = { ...weekly, parentId: "published" };
        const folders = [
            privateRoot,
            publicRoot,
            meetings,
            movedWeekly,
            team,
            published,
        ];
        const assignments = [{ recordingId: "r1", folderId: "weekly" }];
        expect(
            recordingIdsVisibleInFolder(folders, assignments, meetings, ["r1"])
                .size,
        ).toBe(0);
        expect(
            recordingIdsVisibleInFolder(folders, assignments, published, [
                "r1",
            ]),
        ).toEqual(new Set(["r1"]));
    });

    it("does not double-count independent placements in one subtree", () => {
        const folders = [privateRoot, publicRoot, meetings, weekly, team];
        const assignments = [
            { recordingId: "r1", folderId: "weekly" },
            { recordingId: "r1", folderId: "team" },
        ];
        expect(
            effectiveRecordingCounts(folders, assignments, ["r1"]).get(
                "meetings",
            ),
        ).toBe(1);
    });

    it("removes only redundant ancestor placements", () => {
        const folders = [privateRoot, publicRoot, meetings, weekly, published];
        expect(
            canonicalFolderIds(folders, ["meetings", "weekly", "published"]),
        ).toEqual(new Set(["weekly", "published"]));
    });

    it("builds placement paths relative to the configured folder", () => {
        expect(
            relativeFolderPath(
                [privateRoot, meetings, weekly],
                "meetings",
                "weekly",
            ),
        ).toEqual(["Weekly"]);
        expect(
            relativeFolderPath(
                [privateRoot, meetings, weekly],
                "meetings",
                "meetings",
            ),
        ).toEqual([]);
    });

    it("keeps Private visible and hides the complete Public tree in local mode", () => {
        const organization = {
            folders: [privateRoot, publicRoot, meetings, published],
            assignments: [
                { recordingId: "r1", folderId: "meetings" },
                { recordingId: "r1", folderId: "published" },
            ],
        };
        const visible = organizationForDeployment(organization, {
            isHosted: false,
            selfHostMode: "local",
        });
        expect(visible.folders.map((folder) => folder.id)).toEqual([
            "private",
            "meetings",
        ]);
        expect(visible.assignments).toEqual([
            { recordingId: "r1", folderId: "meetings" },
        ]);
        expect(
            organizationForDeployment(organization, {
                isHosted: false,
                selfHostMode: "shared",
            }),
        ).toBe(organization);
    });

    it("applies exports from the selected folder and its ancestors only", () => {
        const folders = [privateRoot, meetings, weekly, team];
        const configurations = [
            { id: "private-export", folderId: "private" },
            { id: "meetings-export", folderId: "meetings" },
            { id: "weekly-export", folderId: "weekly" },
            { id: "team-export", folderId: "team" },
        ];
        expect(
            applicableExportConfigurationIds(folders, "weekly", configurations),
        ).toEqual(["private-export", "meetings-export", "weekly-export"]);
        expect(
            applicableExportConfigurationIds(
                folders,
                "meetings",
                configurations,
            ),
        ).toEqual(["private-export", "meetings-export"]);
    });

    it("uses direct placements for export projection and an implicit Private root fallback", () => {
        const folders = [
            privateRoot,
            publicRoot,
            meetings,
            weekly,
            team,
            published,
        ];
        const assignments = [
            { recordingId: "r1", folderId: "weekly" },
            { recordingId: "r1", folderId: "team" },
            { recordingId: "r1", folderId: "published" },
            { recordingId: "r2", folderId: "published" },
        ];
        expect(
            exportPlacementFolderIds(folders, assignments, "r1", "meetings"),
        ).toEqual(["weekly", "team"]);
        expect(
            exportPlacementFolderIds(folders, assignments, "r2", "private"),
        ).toEqual(["private"]);
    });
});
