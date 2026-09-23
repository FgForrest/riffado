// @vitest-environment jsdom

/**
 * The role bookkeeping lives in the list, not in the pure model: deleting the
 * auto-summary template has to clear `autoSummarizePreset` in the same request
 * that removes the template, or the two drift apart.
 */

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { TemplateList } from "@/components/settings/template-list";
import {
    normalizeTemplateConfig,
    type PromptTemplate,
    type TemplateConfiguration,
} from "@/lib/ai/prompt-templates";
import { SUMMARY_TEMPLATE_KIND } from "@/lib/ai/summary-presets";

const COPY = {
    general: { name: "General Summary", description: "General" },
    "meeting-notes": { name: "Meeting Notes", description: "Meetings" },
    "key-points": { name: "Key Points", description: "Points" },
    "action-items": { name: "Action Items", description: "Items" },
};

const custom = (id: string): PromptTemplate => ({
    id,
    name: `Custom ${id}`,
    prompt: `Do ${id} {transcription}`,
    createdAt: "2026-01-01T00:00:00.000Z",
});

const fetchMock = vi.fn();

function renderList(
    config: TemplateConfiguration,
    auto: { initialId: string | null; visible: boolean } = {
        initialId: null,
        visible: true,
    },
) {
    return render(
        <ConfirmDialogProvider>
            <TemplateList
                field="summaryPrompt"
                kind={SUMMARY_TEMPLATE_KIND}
                presetCopy={COPY}
                initialConfig={config}
                heading="Summary templates"
                promptHelp="help"
                autoRole={{ field: "autoSummarizePreset", ...auto }}
            />
        </ConfirmDialogProvider>,
    );
}

/** Body of the only PUT the list made. */
async function savedPatch(): Promise<Record<string, unknown>> {
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string);
}

async function confirmDelete(name: string) {
    fireEvent.click(screen.getByRole("button", { name: `Delete ${name}` }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
        Array.from(dialog.querySelectorAll("button")).find(
            (b) => b.textContent === "Delete",
        ) as HTMLButtonElement,
    );
}

describe("TemplateList", () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("clears the auto-summary role in the same save that deletes its template", async () => {
        renderList(
            { selectedPrompt: "c1", templates: [custom("c1"), custom("c2")] },
            { initialId: "c2", visible: true },
        );
        expect(screen.getByText("Auto-summary")).toBeTruthy();

        await confirmDelete("Custom c2");

        const patch = await savedPatch();
        expect(patch.autoSummarizePreset).toBeNull();
        expect(
            (patch.summaryPrompt as TemplateConfiguration).templates.map(
                (t) => t.id,
            ),
        ).toEqual(["c1"]);
    });

    it("moves the default role and says so before deleting", async () => {
        renderList({
            selectedPrompt: "c1",
            templates: [custom("c1"), custom("c2")],
        });

        fireEvent.click(
            screen.getByRole("button", { name: "Delete Custom c1" }),
        );
        const dialog = await screen.findByRole("alertdialog");
        expect(dialog.textContent).toContain(
            "Custom c2 becomes the default template.",
        );
        fireEvent.click(
            Array.from(dialog.querySelectorAll("button")).find(
                (b) => b.textContent === "Delete",
            ) as HTMLButtonElement,
        );

        const patch = await savedPatch();
        expect(
            (patch.summaryPrompt as TemplateConfiguration).selectedPrompt,
        ).toBe("c2");
        expect(patch).not.toHaveProperty("autoSummarizePreset");
    });

    it("keeps the stored auto-summary choice hidden while auto-summary is off", () => {
        renderList(
            { selectedPrompt: "c1", templates: [custom("c1"), custom("c2")] },
            { initialId: "c2", visible: false },
        );
        expect(screen.queryByText("Auto-summary")).toBeNull();
    });

    it("cannot delete the last template", () => {
        renderList({ selectedPrompt: "c1", templates: [custom("c1")] });
        expect(
            (
                screen.getByRole("button", {
                    name: "Delete Custom c1",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
    });

    it("pages through templates ten at a time", () => {
        const templates = Array.from({ length: 12 }, (_, i) =>
            custom(`c${i + 1}`),
        );
        renderList({ selectedPrompt: "c1", templates });

        expect(screen.getByText("1–10 of 12")).toBeTruthy();
        expect(screen.queryByText("Custom c11")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Next page" }));
        expect(screen.getByText("11–12 of 12")).toBeTruthy();
        expect(screen.getByText("Custom c11")).toBeTruthy();
        expect(screen.queryByText("Custom c1")).toBeNull();
    });

    it("saves an unchanged built-in as nothing stored, so it keeps following the source", async () => {
        renderList(normalizeTemplateConfig(null, SUMMARY_TEMPLATE_KIND));

        fireEvent.click(
            screen.getByRole("button", { name: "Edit General Summary" }),
        );
        const dialog = await screen.findByRole("dialog");
        const restore = Array.from(dialog.querySelectorAll("button")).find(
            (b) => b.textContent === "Restore built-in version",
        ) as HTMLButtonElement;
        expect(restore.disabled).toBe(true);
        fireEvent.click(
            Array.from(dialog.querySelectorAll("button")).find(
                (b) => b.textContent === "Save",
            ) as HTMLButtonElement,
        );

        const patch = await savedPatch();
        expect(
            (patch.summaryPrompt as TemplateConfiguration).templates[0],
        ).toMatchObject({ id: "general", name: null, prompt: null });
    });

    it("offers the deleted built-ins back", async () => {
        renderList({
            selectedPrompt: "c1",
            templates: [custom("c1")],
        });

        fireEvent.click(
            screen.getByRole("button", { name: "Add built-in templates back" }),
        );

        const patch = await savedPatch();
        expect(
            (patch.summaryPrompt as TemplateConfiguration).templates.map(
                (t) => t.id,
            ),
        ).toEqual([
            "c1",
            "general",
            "meeting-notes",
            "key-points",
            "action-items",
        ]);
    });
});
