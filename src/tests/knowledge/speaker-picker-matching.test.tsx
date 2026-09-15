/**
 * The speaker autocomplete must not create duplicate people when a matching
 * person already exists. Selection and creation are explicit modal actions.
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

async function renderAndType(
    query: string,
    onPick = vi.fn().mockResolvedValue(true),
) {
    const onClose = vi.fn();
    render(
        <SpeakerPicker label="Speaker 0" onPick={onPick} onClose={onClose} />,
    );
    await waitFor(() => {
        expect(screen.queryByText("Loading people…")).toBeNull();
    });
    fireEvent.change(screen.getByRole("combobox"), {
        target: { value: query },
    });
    return { onClose, onPick };
}

describe("SpeakerPicker matching", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("selects an exact person even when they fall below the visible results", async () => {
        stubPeople(NINE_JANS);
        const { onPick } = await renderAndType("Jan");

        fireEvent.click(screen.getByRole("button", { name: "Select" }));

        await waitFor(() => {
            expect(onPick).toHaveBeenCalledWith({ personId: "p-exact" });
        });
    });

    it("selects a person chosen from the autocomplete", async () => {
        stubPeople([person("p-1", "Jan"), person("p-2", "Petra")]);
        const { onPick } = await renderAndType("Pe");

        fireEvent.click(screen.getByRole("button", { name: "Petra" }));
        fireEvent.click(screen.getByRole("button", { name: "Select" }));

        await waitFor(() => {
            expect(onPick).toHaveBeenCalledWith({ personId: "p-2" });
        });
    });

    it("changes the action to Create for an unknown name", async () => {
        stubPeople([person("p-1", "Petra")]);
        const { onPick } = await renderAndType("Jan");

        fireEvent.click(screen.getByRole("button", { name: "Create" }));

        await waitFor(() => {
            expect(onPick).toHaveBeenCalledWith({ displayName: "Jan" });
        });
    });

    it("closes without changes from Cancel", async () => {
        stubPeople([]);
        const { onClose, onPick } = await renderAndType("");

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(onClose).toHaveBeenCalledOnce();
        expect(onPick).not.toHaveBeenCalled();
    });
});
