// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));

vi.mock("sonner", () => ({
    toast: { success: toastSuccess, error: vi.fn() },
}));

import { MarkdownActions } from "@/components/dashboard/markdown-actions";

describe("MarkdownActions", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    beforeEach(() => {
        vi.clearAllMocks();
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("offers the rendered transcript Markdown as a download", () => {
        render(
            <MarkdownActions
                recordingId="rec-1"
                kind="transcript"
                source="plaud"
            />,
        );

        expect(
            screen
                .getByRole("link", { name: "Download transcript Markdown" })
                .getAttribute("href"),
        ).toBe("/api/recordings/rec-1/markdown/transcript?source=plaud");
    });

    it("copies the same summary Markdown returned by the download route", async () => {
        const markdown = "---\ntitle: Summary\n---\n";
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(markdown, {
                    headers: { "Content-Type": "text/markdown" },
                }),
            ),
        );
        render(
            <MarkdownActions
                recordingId="rec-1"
                kind="summary"
                source="riffado"
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Copy summary Markdown" }),
        );

        await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));
        expect(fetch).toHaveBeenCalledWith(
            "/api/recordings/rec-1/markdown/summary?source=riffado",
            { cache: "no-store" },
        );
        expect(toastSuccess).toHaveBeenCalledWith("Summary Markdown copied");
    });
});
