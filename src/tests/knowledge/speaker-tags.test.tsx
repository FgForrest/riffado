// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerTags } from "@/components/people/speaker-tags";

interface FetchScenario {
    initialSpeakers?: unknown[];
    savedSpeakers?: unknown[];
    people?: unknown[];
}

function response(body: unknown): Response {
    return { ok: true, json: async () => body } as Response;
}

function stubFetch(scenario: FetchScenario) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
            return response({ speakers: scenario.savedSpeakers ?? [] });
        }
        if (url === "/api/people") {
            return response({ people: scenario.people ?? [] });
        }
        return response({ speakers: scenario.initialSpeakers ?? [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

function renderTags() {
    return render(
        <SpeakerTags
            recordingId="rec-1"
            source="riffado"
            speakers={[{ speaker: "speaker_0", label: "Speaker 0" }]}
            onAttributionsChange={vi.fn()}
        />,
    );
}

describe("SpeakerTags", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("links a confirmed person and unlinks them from the cross button", async () => {
        const fetchMock = stubFetch({
            initialSpeakers: [
                {
                    label: "speaker_0",
                    personId: "person-1",
                    personName: "Jan",
                    status: "confirmed",
                },
            ],
        });
        renderTags();

        const personLink = await screen.findByRole("link", { name: "Jan" });
        expect(personLink.getAttribute("href")).toBe("/people/person-1");

        fireEvent.click(
            screen.getByRole("button", {
                name: "Unlink Jan from Speaker 0",
            }),
        );

        await waitFor(() => {
            expect(
                screen.getByRole("button", { name: "Speaker 0" }),
            ).toBeDefined();
        });
        const put = fetchMock.mock.calls.find(
            ([, init]) => init?.method === "PUT",
        );
        expect(JSON.parse(String(put?.[1]?.body))).toEqual({
            label: "speaker_0",
        });
    });

    it("selects an existing person through the modal", async () => {
        const fetchMock = stubFetch({
            people: [
                {
                    id: "person-2",
                    displayName: "Petra",
                    primaryEmail: null,
                },
            ],
            savedSpeakers: [
                {
                    label: "speaker_0",
                    personId: "person-2",
                    personName: "Petra",
                    status: "confirmed",
                },
            ],
        });
        renderTags();

        fireEvent.click(
            await screen.findByRole("button", { name: "Speaker 0" }),
        );
        fireEvent.change(await screen.findByRole("combobox"), {
            target: { value: "Petra" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Select" }));

        await screen.findByRole("link", { name: "Petra" });
        const put = fetchMock.mock.calls.find(
            ([, init]) => init?.method === "PUT",
        );
        expect(JSON.parse(String(put?.[1]?.body))).toEqual({
            label: "speaker_0",
            personId: "person-2",
        });
    });

    it("creates a new person and Cancel makes no change", async () => {
        const fetchMock = stubFetch({
            savedSpeakers: [
                {
                    label: "speaker_0",
                    personId: "person-3",
                    personName: "Nova",
                    status: "confirmed",
                },
            ],
        });
        renderTags();

        fireEvent.click(
            await screen.findByRole("button", { name: "Speaker 0" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
        ).toHaveLength(0);

        fireEvent.click(screen.getByRole("button", { name: "Speaker 0" }));
        fireEvent.change(await screen.findByRole("combobox"), {
            target: { value: "Nova" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create" }));

        await screen.findByRole("link", { name: "Nova" });
        const put = fetchMock.mock.calls.find(
            ([, init]) => init?.method === "PUT",
        );
        expect(JSON.parse(String(put?.[1]?.body))).toEqual({
            label: "speaker_0",
            displayName: "Nova",
        });
    });
});
