// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnownFacts, OtherNames } from "@/components/people/known-facts";
import type { PageRelation } from "@/lib/knowledge/fact-page";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh, push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const EDITING = {
    subject: { kind: "person" as const, id: "jan", typeKey: "person" },
    relations: [
        {
            key: "leads",
            label: "leads",
            subjectTypes: ["person"],
            objectTypes: ["project"],
            objectKind: "entity" as const,
            cardinality: "many" as const,
        },
    ],
    typeLabels: { project: "Project" },
    ownScope: "personal" as const,
};

function respond(status = 200, body: unknown = {}) {
    const fetch = vi.fn(async () => Response.json(body, { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

const relations: PageRelation[] = [
    {
        key: "leads",
        label: "leads",
        facts: [
            {
                id: "f-1",
                direction: "subject",
                other: { kind: "entity", id: "orion", text: "Orion" },
                scope: "org",
                origin: "recording",
                evidence: [
                    {
                        recordingId: "rec-2",
                        kind: "audio",
                        title: "June sync",
                        recordedAt: "2026-06-14T09:00:00.000Z",
                        startMs: 125_000,
                        quoted: false,
                        view: "org",
                    },
                    {
                        recordingId: "rec-1",
                        kind: "audio",
                        title: "Weekly",
                        recordedAt: "2026-03-03T12:04:00.000Z",
                        startMs: 724_000,
                        quoted: false,
                        view: "private",
                    },
                ],
            },
        ],
    },
    {
        key: "reports_to",
        label: "reports to",
        facts: [
            {
                id: "f-2",
                direction: "object",
                other: { kind: "person", id: "pavel", text: "Pavel" },
                scope: "personal",
                origin: "manual",
                evidence: [],
            },
        ],
    },
];

describe("KnownFacts", () => {
    afterEach(cleanup);

    it("reads each fact from the page's side, with who else it names", () => {
        render(<KnownFacts name="Jan" relations={relations} />);
        expect(screen.getByRole("heading", { name: "leads" })).toBeDefined();
        expect(
            screen.getByRole("heading", { name: "reports to Jan" }),
        ).toBeDefined();
        expect(
            screen.getByRole("link", { name: /Orion/ }).getAttribute("href"),
        ).toBe("/almanac/things/orion");
        expect(
            screen.getByRole("link", { name: /Pavel/ }).getAttribute("href"),
        ).toBe("/almanac/pavel");
    });

    it("counts the recordings a fact was said in, and links to each moment", () => {
        render(<KnownFacts name="Jan" relations={relations} />);
        expect(screen.getByText(/Supported by 2 recordings/)).toBeDefined();
        expect(screen.getByText(/Entered by hand/)).toBeDefined();
        const june = screen.getByRole("link", { name: /June sync 2:05/ });
        expect(june.getAttribute("href")).toBe(
            "/dashboard?recording=rec-2&view=org",
        );
        expect(
            screen
                .getByRole("link", { name: /Weekly 12:04/ })
                .getAttribute("href"),
        ).toBe("/recordings/rec-1");
    });

    it("links a mail to the pile, and marks words quoted from an earlier writer", () => {
        render(
            <KnownFacts
                name="Jan"
                relations={[
                    {
                        key: "has_role",
                        label: "has role",
                        facts: [
                            {
                                id: "f-3",
                                direction: "subject",
                                other: { kind: "literal", text: "CFO" },
                                scope: "personal",
                                origin: "mail",
                                evidence: [
                                    {
                                        recordingId: "mail-1",
                                        kind: "mail",
                                        title: "Re: Budget",
                                        recordedAt: "2026-06-20T08:00:00.000Z",
                                        startMs: null,
                                        quoted: true,
                                        view: "private",
                                    },
                                    {
                                        recordingId: "rec-1",
                                        kind: "audio",
                                        title: "Weekly",
                                        recordedAt: "2026-03-03T12:04:00.000Z",
                                        startMs: 724_000,
                                        quoted: false,
                                        view: "private",
                                    },
                                ],
                            },
                        ],
                    },
                ]}
            />,
        );
        expect(
            screen.getByText(/Supported by 1 recording and 1 mail/),
        ).toBeDefined();
        expect(
            screen
                .getByRole("link", { name: /Re: Budget/ })
                .getAttribute("href"),
        ).toBe("/dashboard?recording=mail-1");
        expect(
            screen.getByText("quoted from an earlier message"),
        ).toBeDefined();
    });

    it("says when nothing is known", () => {
        render(<KnownFacts name="Jan" relations={[]} />);
        expect(screen.getByText("Nothing is known yet.")).toBeDefined();
    });
});

describe("OtherNames", () => {
    afterEach(cleanup);

    it("lists aliases and how transcription heard the name", () => {
        render(
            <OtherNames
                names={[
                    { text: "Honza", kind: "alias" },
                    { text: "Novák", kind: "heard_as" },
                ]}
            />,
        );
        expect(screen.getByText(/Honza/)).toBeDefined();
        expect(screen.getByText(/heard as Novák/)).toBeDefined();
    });

    it("shows nothing without other names", () => {
        const { container } = render(<OtherNames names={[]} />);
        expect(container.textContent).toBe("");
    });
});

describe("editing what is known", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        refresh.mockClear();
    });

    it("lets the viewer change and erase their own facts, not the Organization's", async () => {
        const fetch = respond();
        render(
            <KnownFacts name="Jan" relations={relations} editing={EDITING} />,
        );
        // f-1 is the Organization's; f-2 (object side) is the viewer's own.
        expect(
            screen.getAllByRole("button", { name: "Erase fact" }),
        ).toHaveLength(1);
        // Only a fact the page is the subject of is changed here.
        expect(
            screen.queryByRole("button", { name: "Change fact" }),
        ).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Erase fact" }));
        fireEvent.click(screen.getByRole("button", { name: "Erase" }));
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith("/api/knowledge/facts/f-2", {
                method: "DELETE",
            }),
        );
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it("offers a fact to be added, even when nothing is known yet", () => {
        render(<KnownFacts name="Jan" relations={[]} editing={EDITING} />);
        expect(
            screen.getByRole("button", { name: "Add a fact" }),
        ).toBeDefined();
    });

    it("adds a nickname, and takes back only the viewer's own", async () => {
        const fetch = respond(201, { id: "a-2" });
        render(
            <OtherNames
                names={[
                    {
                        id: "a-1",
                        text: "Honza",
                        kind: "alias",
                        scope: "personal",
                    },
                    { id: "a-org", text: "JN", kind: "alias", scope: "org" },
                ]}
                editing={{ target: { personId: "jan" }, ownScope: "personal" }}
            />,
        );
        expect(
            screen.getByRole("button", { name: "Remove Honza" }),
        ).toBeDefined();
        expect(screen.queryByRole("button", { name: "Remove JN" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Add a nickname" }));
        fireEvent.change(
            screen.getByRole("textbox", { name: "New nickname" }),
            {
                target: { value: "Jeník" },
            },
        );
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                "/api/knowledge/aliases",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({
                        target: { personId: "jan" },
                        text: "Jeník",
                    }),
                }),
            ),
        );
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });
});
