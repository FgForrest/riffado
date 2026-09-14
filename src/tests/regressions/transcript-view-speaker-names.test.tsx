/**
 * Naming a speaker from the transcript.
 *
 * Names are an overlay on one transcript, not on the recording: two
 * transcripts of the same recording carry the same raw `speaker_N` labels for
 * different people, so the view must never show one transcript's names over
 * another's turns. The picker has to know who is already attributed, and a
 * write that fails has to say so instead of closing as though it worked.
 */

// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptView } from "@/components/dashboard/transcript-view";

vi.mock("sonner", () => ({
    toast: {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
    },
}));

const TURNS = [
    { speaker: "speaker_0", startMs: 0, endMs: 2000, text: "Ahoj." },
];

interface SpeakerRow {
    label: string;
    personId: string | null;
    personName: string | null;
    status: string;
}

function jsonResponse(body: unknown, ok = true): Response {
    return { ok, status: ok ? 200 : 404, json: async () => body } as Response;
}

/**
 * Route the component's two GETs and its PUT. `speakers` answers the
 * transcript's overlay, `people` the picker's list, `putOk` the write.
 */
function stubFetch(opts: {
    speakers?: SpeakerRow[] | "fail";
    people?: { id: string; displayName: string; primaryEmail: string | null }[];
    putOk?: boolean;
}): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: { method?: string }) => {
            if (init?.method === "PUT") {
                return jsonResponse(
                    opts.putOk === false
                        ? { error: "Person not found", code: "NOT_FOUND" }
                        : { speaker: {} },
                    opts.putOk !== false,
                );
            }
            if (url.startsWith("/api/people")) {
                return jsonResponse({ people: opts.people ?? [] });
            }
            if (opts.speakers === "fail") return jsonResponse({}, false);
            return jsonResponse({ speakers: opts.speakers ?? [] });
        }),
    );
}

function renderView(source: string) {
    return render(
        <TranscriptView
            text="speaker_0: Ahoj."
            source={source}
            model="gpt-4o-transcribe-diarize"
            storedTurns={TURNS}
            recordingId="rec-1"
        />,
    );
}

describe("TranscriptView speaker names", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("drops a name when the transcript it belongs to is replaced", async () => {
        stubFetch({
            speakers: [
                {
                    label: "speaker_0",
                    personId: "p-1",
                    personName: "Jan",
                    status: "confirmed",
                },
            ],
        });
        const view = renderView("riffado");
        await waitFor(() => {
            expect(screen.getByText("Jan")).toBeDefined();
        });

        // The Plaud transcript's `speaker_0` is somebody else, and this read
        // fails, so the view must fall back to the raw label rather than keep
        // the previous transcript's answer.
        stubFetch({ speakers: "fail" });
        view.rerender(
            <TranscriptView
                text="speaker_0: Ahoj."
                source="plaud"
                model="gpt-4o-transcribe-diarize"
                storedTurns={TURNS}
                recordingId="rec-1"
            />,
        );

        await waitFor(() => {
            expect(screen.getByText("Speaker 0")).toBeDefined();
        });
        expect(screen.queryByText("Jan")).toBeNull();
    });

    it("marks the attributed person in the picker", async () => {
        stubFetch({
            speakers: [
                {
                    label: "speaker_0",
                    personId: "p-1",
                    personName: "Jan",
                    status: "confirmed",
                },
            ],
            people: [
                { id: "p-1", displayName: "Jan", primaryEmail: null },
                { id: "p-2", displayName: "Petr", primaryEmail: null },
            ],
        });
        renderView("riffado");
        await waitFor(() => {
            expect(screen.getByText("Jan")).toBeDefined();
        });

        fireEvent.click(screen.getByTitle("Change who this is"));
        await waitFor(() => {
            expect(screen.getByRole("list")).toBeDefined();
        });

        const rows = within(screen.getByRole("list")).getAllByRole("button");
        const jan = rows.find((row) => row.textContent === "Jan");
        const petr = rows.find((row) => row.textContent === "Petr");
        expect(jan).toBeDefined();
        expect(petr).toBeDefined();
        // Only the attributed row carries the check mark.
        expect(jan?.querySelector("svg")).not.toBeNull();
        expect(petr?.querySelector("svg")).toBeNull();
    });

    it("reports a failed attribution and keeps the picker open", async () => {
        stubFetch({
            speakers: [],
            people: [{ id: "p-1", displayName: "Jan", primaryEmail: null }],
            putOk: false,
        });
        renderView("riffado");
        await waitFor(() => {
            expect(screen.getByText("Speaker 0")).toBeDefined();
        });

        fireEvent.click(screen.getByTitle("Name this speaker"));
        await waitFor(() => {
            expect(screen.getByRole("list")).toBeDefined();
        });
        fireEvent.click(
            within(screen.getByRole("list")).getByRole("button", {
                name: "Jan",
            }),
        );

        await waitFor(() => {
            expect(toast.error).toHaveBeenCalled();
        });
        // The picker stays open so the attribution can be retried.
        expect(screen.getByLabelText("Who is Speaker 0?")).toBeDefined();
    });
});
