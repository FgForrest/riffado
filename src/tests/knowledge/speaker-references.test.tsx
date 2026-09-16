// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "@/components/markdown";
import {
    canonicalizeSummarySpeakerReferences,
    projectSummarySpeakerReferencesForExport,
    speakerAnchorId,
    speakerLabelFromSummaryHref,
} from "@/lib/knowledge/speaker-references";

describe("summary speaker references", () => {
    afterEach(cleanup);

    it("uses stable anchors for numbered transcript speakers", () => {
        expect(speakerAnchorId("speaker_0")).toBe("speaker-0");
        expect(speakerLabelFromSummaryHref("#speaker-12")).toBe("speaker_12");
        expect(speakerLabelFromSummaryHref("https://example.com")).toBeNull();
    });

    it("projects a confirmed person link only while rendering", () => {
        const markdown = "[Speaker 0](#speaker-0) approved the proposal.";
        render(
            <Markdown
                speakerAttributions={{
                    "Speaker 0": {
                        personId: "person-1",
                        name: "Jane Doe",
                    },
                }}
            >
                {markdown}
            </Markdown>,
        );

        const link = screen.getByRole("link", { name: "Jane Doe" });
        expect(link.getAttribute("href")).toBe("/people/person-1");
        expect(markdown).toBe("[Speaker 0](#speaker-0) approved the proposal.");
    });

    it("canonicalizes a plain model-authored speaker reference for rendering", () => {
        const markdown = "Speaker 0 approved the proposal.";
        render(
            <Markdown
                speakerAttributions={{
                    speaker_0: { personId: "person-1", name: "Jane Doe" },
                }}
            >
                {markdown}
            </Markdown>,
        );

        const link = screen.getByRole("link", { name: "Jane Doe" });
        expect(link.getAttribute("href")).toBe("/people/person-1");
        expect(markdown).toBe("Speaker 0 approved the proposal.");
        expect(canonicalizeSummarySpeakerReferences(markdown)).toBe(
            "[Speaker 0](#speaker-0) approved the proposal.",
        );
    });

    it("keeps an unresolved UI reference linked to its speaker tag", () => {
        render(<Markdown>[Speaker 1](#speaker-1) raised a concern.</Markdown>);

        expect(
            screen
                .getByRole("link", { name: "Speaker 1" })
                .getAttribute("href"),
        ).toBe("#speaker-1");
    });

    it("exports confirmed and unknown speakers as plain text", () => {
        const projected = projectSummarySpeakerReferencesForExport(
            "[Speaker 0](#speaker-0) asked Speaker 1.",
            (speaker) => (speaker === "Speaker 0" ? "Jane Doe" : null),
        );

        expect(projected).toBe("Jane Doe asked Speaker 1.");
        expect(projected).not.toContain("](");
    });
});
