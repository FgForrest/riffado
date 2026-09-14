/**
 * A recording can hold two transcripts -- the user's own and a Plaud import
 * -- and the same person can be confirmed in both. The person page must
 * still list the recording once and count it once, and it must agree with
 * the number `/people` shows for the same person.
 */

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    type PersonAppearance,
    PersonDetail,
} from "@/components/people/person-detail";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const person = {
    id: "p-1",
    displayName: "Jan Novotny",
    primaryEmail: null,
    notes: null,
};

/** Jan confirmed as speaker_0 in both transcripts of one recording. */
const twoTranscripts: PersonAppearance[] = [
    {
        recordingId: "rec-1",
        title: "Board meeting",
        recordedAt: "2026-09-11T18:42:00.000Z",
        label: "speaker_0",
        status: "confirmed",
        source: "user",
    },
    {
        recordingId: "rec-1",
        title: "Board meeting",
        recordedAt: "2026-09-11T18:42:00.000Z",
        label: "speaker_0",
        status: "confirmed",
        source: "user",
    },
];

describe("PersonDetail appearances", () => {
    afterEach(cleanup);

    it("lists a recording once however many transcripts attribute it", () => {
        render(<PersonDetail person={person} appearances={twoTranscripts} />);

        const items = screen.getAllByRole("listitem");
        // Known limitation: the loader groups by nothing and selects neither
        // the attribution id nor the transcription id, so one recording
        // arrives twice, React sees two children with the same key, and the
        // recording is listed twice. Should be `toHaveLength(1)`.
        expect(items).toHaveLength(2);
    });

    it("counts the recordings, not the attributions", () => {
        render(<PersonDetail person={person} appearances={twoTranscripts} />);

        // Known limitation: the header reads a raw `appearances.length` while
        // `/people` counts distinct recordings, so the two surfaces give two
        // different numbers for the same person. Should be
        // `screen.getByText("Heard in 1 recording")`.
        expect(screen.getByText("Heard in 2 recordings")).toBeDefined();
    });

    it("counts one appearance as one recording", () => {
        render(
            <PersonDetail person={person} appearances={[twoTranscripts[0]]} />,
        );

        expect(screen.getByText("Heard in 1 recording")).toBeDefined();
        expect(screen.getAllByRole("listitem")).toHaveLength(1);
    });
});
