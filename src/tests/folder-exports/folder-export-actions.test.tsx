// @vitest-environment jsdom

/**
 * The folder export dialog with Google Drive: connection state, choosing
 * the folder through the Picker, the saved request, and coming back to the
 * dialog after Google's consent screen.
 */

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const pickDriveFolder = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/lib/integrations/google/picker-client", () => ({
    pickDriveFolder,
}));

import { FolderExportActions } from "@/components/dashboard/folder-export-actions";
import type { FolderExportConfigurationDto } from "@/lib/folder-exports/types";
import type { RecordingFolder } from "@/types/folder";

const folder: RecordingFolder = {
    id: "f1",
    parentId: "private",
    name: "Meetings",
    kind: "custom",
    sortOrder: 0,
    scope: "personal",
    version: 0,
};

type ConnectionStatus = "active" | "needs_reconnect" | null;

function mockServer(options: {
    connection: ConnectionStatus;
    configured?: FolderExportConfigurationDto[];
}) {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? "GET";
            requests.push({
                url,
                method,
                body: init?.body ? JSON.parse(String(init.body)) : null,
            });
            const json = (value: unknown, status = 200) =>
                new Response(JSON.stringify(value), { status });
            if (url === "/api/folders/f1/exports" && method === "GET") {
                return json({
                    configured: options.configured ?? [],
                    applicableIds: [],
                });
            }
            if (url === "/api/integrations/google") {
                return json({
                    available: true,
                    connection: options.connection
                        ? {
                              email: "jane@example.com",
                              hostedDomain: "example.com",
                              status: options.connection,
                          }
                        : null,
                });
            }
            if (url === "/api/integrations/google/picker-token") {
                return json({
                    accessToken: "access",
                    apiKey: "key",
                    appId: "1234",
                    clientId: "client",
                });
            }
            if (url === "/api/folders/f1/exports" && method === "POST") {
                return json({ configuration: {} }, 201);
            }
            return json({ error: "unexpected" }, 500);
        },
    );
    vi.stubGlobal("fetch", fetchMock);
    return requests;
}

function renderActions() {
    render(
        <FolderExportActions
            folder={folder}
            providers={{ filesystem: false, googleDrive: true }}
            privateTree
        />,
    );
}

describe("folder export dialog with Google Drive", () => {
    beforeEach(() => {
        window.history.replaceState(null, "", "/dashboard");
        pickDriveFolder.mockReset();
        toastMock.success.mockReset();
        toastMock.error.mockReset();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("picks a folder and saves a Drive export with Docs by default", async () => {
        const requests = mockServer({ connection: "active" });
        pickDriveFolder.mockResolvedValue({
            id: "drivefolder1",
            name: "Company exports",
        });
        renderActions();
        fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
        fireEvent.click(
            await screen.findByRole("button", {
                name: /Add Google Drive export/,
            }),
        );
        await screen.findByText("Connected as jane@example.com");
        const save = screen.getByRole("button", { name: "Save export" });
        expect(save).toHaveProperty("disabled", true);

        fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));
        await screen.findByText("Company exports");
        expect(pickDriveFolder).toHaveBeenCalledWith(
            {
                accessToken: "access",
                apiKey: "key",
                appId: "1234",
                clientId: "client",
            },
            "Choose the folder to export into",
        );
        fireEvent.click(screen.getByRole("button", { name: "Save export" }));

        await waitFor(() =>
            expect(
                requests.find((request) => request.method === "POST")?.body,
            ).toEqual({
                provider: "google-drive",
                rootFolderId: "drivefolder1",
                transcriptFormat: "google_doc",
                summaryFormat: "google_doc",
                exportAudio: true,
                exportTranscript: true,
                exportSummary: true,
            }),
        );
        expect(toastMock.success).toHaveBeenCalledWith(
            "Export saved and scheduled",
        );
    });

    it("asks to connect before a folder can be chosen", async () => {
        mockServer({ connection: null });
        renderActions();
        fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
        fireEvent.click(
            await screen.findByRole("button", {
                name: /Add Google Drive export/,
            }),
        );
        await screen.findByRole("button", { name: "Connect Google account" });
        expect(
            screen.getByRole("button", { name: /Choose folder/ }),
        ).toHaveProperty("disabled", true);
    });

    it("says when the account must be reconnected", async () => {
        mockServer({ connection: "needs_reconnect" });
        renderActions();
        fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
        fireEvent.click(
            await screen.findByRole("button", {
                name: /Add Google Drive export/,
            }),
        );
        await screen.findByRole("button", { name: "Reconnect" });
        expect(
            screen.getByText(/Exports to Google Drive are paused/),
        ).toBeTruthy();
    });

    it("reopens on the Drive form after Google's consent screen", async () => {
        mockServer({ connection: "active" });
        window.history.replaceState(
            null,
            "",
            "/dashboard?folder=f1&googleExport=f1&google=connected",
        );
        renderActions();
        await screen.findByText("Connected as jane@example.com");
        expect(screen.getByText("No folder chosen")).toBeTruthy();
        expect(window.location.search).toBe("?folder=f1&google=connected");
    });

    it("lists a Drive export by its folder name", async () => {
        mockServer({
            connection: "active",
            configured: [
                {
                    id: "e1",
                    folderId: "f1",
                    provider: "google-drive",
                    targetPath: "drivefolder1",
                    exportAudio: true,
                    exportTranscript: false,
                    exportSummary: true,
                    lastError:
                        "The Google Drive folder of this export no longer exists or is in the trash",
                    lastErrorAt: "2026-09-23T10:00:00.000Z",
                    googleDrive: {
                        rootFolderId: "drivefolder1",
                        rootFolderName: "Company exports",
                        driveId: null,
                        transcriptFormat: "markdown",
                        summaryFormat: "both",
                    },
                },
            ],
        });
        renderActions();
        fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
        await screen.findByText("Google Drive: Company exports");
        expect(screen.getByText("Audio, Summary")).toBeTruthy();
        expect(
            screen.getByText(/no longer exists or is in the trash/),
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    });

    it("puts a lost connection above the Drive exports it pauses", async () => {
        mockServer({
            connection: "needs_reconnect",
            configured: [
                {
                    id: "e1",
                    folderId: "f1",
                    provider: "google-drive",
                    targetPath: "drivefolder1",
                    exportAudio: true,
                    exportTranscript: false,
                    exportSummary: false,
                    lastError: null,
                    lastErrorAt: null,
                    googleDrive: {
                        rootFolderId: "drivefolder1",
                        rootFolderName: "Company exports",
                        driveId: null,
                        transcriptFormat: "markdown",
                        summaryFormat: "markdown",
                    },
                },
            ],
        });
        renderActions();
        fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
        await screen.findByRole("button", { name: "Reconnect" });
        expect(screen.getByText("Google Drive: Company exports")).toBeTruthy();
    });
});
