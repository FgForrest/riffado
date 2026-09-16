// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "@/components/markdown";
import {
    canonicalizeSummarySpeakerReferences,
    inferSummarySpeakerNumberOffset,
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

    it("corrects a complete one-based summary against zero-based speakers", () => {
        const markdown =
            "- Speaker 1\n- Speaker 2\n- Speaker 3\nSpeaker 3 owns the follow-up.";
        const offset = inferSummarySpeakerNumberOffset(markdown, [
            "speaker_0",
            "speaker_1",
            "speaker_2",
        ]);

        expect(offset).toBe(-1);
        render(
            <Markdown
                speakerAttributions={{
                    speaker_0: { personId: "person-1", name: "Jan" },
                    speaker_1: { personId: "person-2", name: "Jakub" },
                    speaker_2: { personId: "person-3", name: "Petra" },
                }}
                speakerNumberOffset={offset}
            >
                {markdown}
            </Markdown>,
        );

        expect(screen.getByRole("link", { name: "Jan" })).toBeDefined();
        expect(screen.getByRole("link", { name: "Jakub" })).toBeDefined();
        expect(screen.getAllByRole("link", { name: "Petra" })).toHaveLength(2);
        expect(screen.queryByRole("link", { name: "Speaker 3" })).toBeNull();
    });

    it("does not shift an incomplete subset of speaker references", () => {
        expect(
            inferSummarySpeakerNumberOffset("Speaker 1 followed up.", [
                "speaker_0",
                "speaker_1",
            ]),
        ).toBe(0);
    });

    it("shifts unresolved summary labels and anchors for rendering", () => {
        render(
            <Markdown speakerNumberOffset={-1}>
                [Speaker 1](#speaker-1) followed up.
            </Markdown>,
        );

        expect(
            screen
                .getByRole("link", { name: "Speaker 0" })
                .getAttribute("href"),
        ).toBe("#speaker-0");
    });

    it("exports confirmed and unknown speakers as plain text", () => {
        const projected = projectSummarySpeakerReferencesForExport(
            "[Speaker 0](#speaker-0) asked Speaker 1.",
            (speaker) => (speaker === "Speaker 0" ? "Jane Doe" : null),
        );

        expect(projected).toBe("Jane Doe asked Speaker 1.");
        expect(projected).not.toContain("](");
    });

    it("applies an inferred one-based offset to portable exports", () => {
        const projected = projectSummarySpeakerReferencesForExport(
            "Speaker 1 asked [Speaker 2](#speaker-2).",
            (speaker) =>
                ({ speaker_0: "Jane Doe", speaker_1: "John Doe" })[speaker] ??
                null,
            -1,
        );

        expect(projected).toBe("Jane Doe asked John Doe.");
    });
});
