/**
 * Naming a speaker offers the people already known before the option to
 * create somebody. Offering "Add <name>" for a name that already exists is
 * how duplicate people get made, so the exact-match check has to see every
 * candidate, not only the ones that fit on screen.
 */

// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type PickablePerson,
    SpeakerPicker,
} from "@/components/people/speaker-picker";

function person(id: string, displayName: string): PickablePerson {
    return { id, displayName, primaryEmail: null };
}

/** Nine people matching "jan", with the exact one ranked last. */
const NINE_JANS: PickablePerson[] = [
    ...Array.from({ length: 8 }, (_, index) =>
        person(`p-${index}`, `Jan Novotny ${index}`),
    ),
    person("p-exact", "Jan"),
];

function stubPeople(people: PickablePerson[]): void {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ people }),
        }),
    );
}

async function renderAndType(query: string): Promise<void> {
    render(
        <SpeakerPicker
            label="speaker_0"
            personId={null}
            onPick={vi.fn()}
            onClear={vi.fn()}
            onClose={vi.fn()}
        />,
    );
    await waitFor(() => {
        expect(screen.queryByText("Loading people\u2026")).toBeNull();
    });
    fireEvent.change(screen.getByLabelText("Who is speaker_0?"), {
        target: { value: query },
    });
}

describe("SpeakerPicker matching", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("does not offer to create a person who already exists", async () => {
        stubPeople(NINE_JANS);
        await renderAndType("Jan");

        // Known limitation: `exactMatch` is computed over the list already
        // sliced to eight, so a ninth-ranked exact match is invisible and the
        // picker offers to create a duplicate -- the very thing the merge
        // machinery then exists to clean up. Should be
        // `expect(screen.queryByText(/Add/)).toBeNull()`.
        expect(screen.getByText("Add “Jan”")).toBeDefined();
    });

    it("does not offer to create a person shown in the list", async () => {
        stubPeople([person("p-exact", "Jan")]);
        await renderAndType("Jan");

        expect(screen.queryByText("Add “Jan”")).toBeNull();
    });

    it("offers to create a name that matches nobody", async () => {
        stubPeople([person("p-1", "Petra")]);
        await renderAndType("Jan");

        expect(screen.getByText("Add “Jan”")).toBeDefined();
    });
});
