import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

const { getRecordingMarkdownDocument } = vi.hoisted(() => ({
    getRecordingMarkdownDocument: vi.fn(),
}));

vi.mock("@/lib/export/document-sidecars", () => ({
    getRecordingMarkdownDocument,
}));

import { GET } from "@/app/api/recordings/[id]/markdown/[kind]/route";

function context(kind: string) {
    return { params: Promise.resolve({ id: "rec-1", kind }) };
}

describe("recording Markdown route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns the portable disk-export document as an attachment", async () => {
        getRecordingMarkdownDocument.mockResolvedValue({
            filename: "Weekly_status.transcript.md",
            content: "---\nparticipants:\n  - Jane Doe\n---\n",
        });

        const response = await GET(
            new Request(
                "http://localhost/api/recordings/rec-1/markdown/transcript",
            ),
            context("transcript") as never,
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
            "text/markdown; charset=utf-8",
        );
        expect(response.headers.get("content-disposition")).toContain(
            'filename="Weekly_status.transcript.md"',
        );
        expect(await response.text()).toContain("participants:");
        expect(getRecordingMarkdownDocument).toHaveBeenCalledWith(
            "user-1",
            "rec-1",
            "transcript",
        );
    });

    it("rejects unknown document kinds", async () => {
        const response = await GET(
            new Request("http://localhost/api/recordings/rec-1/markdown/audio"),
            context("audio") as never,
        );

        expect(response.status).toBe(404);
        expect(getRecordingMarkdownDocument).not.toHaveBeenCalled();
    });

    it("returns 404 when the requested document does not exist", async () => {
        getRecordingMarkdownDocument.mockResolvedValue(null);

        const response = await GET(
            new Request(
                "http://localhost/api/recordings/rec-1/markdown/summary",
            ),
            context("summary") as never,
        );

        expect(response.status).toBe(404);
    });
});
