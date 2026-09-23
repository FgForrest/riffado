/**
 * The shared template model behind both summary and title templates.
 *
 * The rules that matter most are the ones a user cannot see: an unedited
 * built-in must keep following the source text, a deleted template must stay
 * deleted, and the default role must never be left pointing at nothing.
 */

import { describe, expect, it } from "vitest";
import { TITLE_TEMPLATE_KIND } from "@/lib/ai/prompt-presets";
import {
    deleteTemplate,
    isValidTemplateConfig,
    missingPresetIds,
    normalizeTemplateConfig,
    type PromptTemplate,
    resolveTemplate,
    restoreMissingPresets,
    saveTemplate,
    seedTemplate,
    type TemplateConfiguration,
    templatePrompt,
} from "@/lib/ai/prompt-templates";
import {
    SUMMARY_PRESETS,
    SUMMARY_TEMPLATE_KIND,
} from "@/lib/ai/summary-presets";

const KIND = SUMMARY_TEMPLATE_KIND;
const BUILTIN_IDS = ["general", "meeting-notes", "key-points", "action-items"];

const custom = (id: string, prompt = `Mine ${id} {transcription}`) =>
    ({
        id,
        name: `Custom ${id}`,
        prompt,
        createdAt: "2026-01-01T00:00:00.000Z",
    }) satisfies PromptTemplate;

const newId = () => "new-1";

describe("normalizeTemplateConfig", () => {
    it("seeds the built-ins, unedited, when nothing is stored", () => {
        for (const raw of [null, undefined, "garbage", 42]) {
            const config = normalizeTemplateConfig(raw, KIND);
            expect(config.selectedPrompt).toBe("general");
            expect(config.templates.map((t) => t.id)).toEqual(BUILTIN_IDS);
            expect(
                config.templates.every(
                    (t) => t.name === null && t.prompt === null,
                ),
            ).toBe(true);
        }
    });

    it("reads the legacy shape as built-ins followed by its custom prompts", () => {
        const config = normalizeTemplateConfig(
            { selectedPrompt: "key-points", customPrompts: [custom("c1")] },
            KIND,
        );
        expect(config.templates.map((t) => t.id)).toEqual([
            ...BUILTIN_IDS,
            "c1",
        ]);
        expect(config.selectedPrompt).toBe("key-points");
    });

    it("takes a saved template list as it stands, so a deleted built-in stays deleted", () => {
        const config = normalizeTemplateConfig(
            {
                selectedPrompt: "c1",
                templates: [seedTemplate("general"), custom("c1")],
            },
            KIND,
        );
        expect(config.templates.map((t) => t.id)).toEqual(["general", "c1"]);
    });

    it("moves a default that points at nothing to the first template", () => {
        const config = normalizeTemplateConfig(
            { selectedPrompt: "gone", templates: [custom("c1"), custom("c2")] },
            KIND,
        );
        expect(config.selectedPrompt).toBe("c1");
    });
});

describe("templatePrompt", () => {
    it("follows the built-in text while the template is unedited", () => {
        expect(templatePrompt(seedTemplate("meeting-notes"), KIND)).toBe(
            SUMMARY_PRESETS["meeting-notes"].prompt,
        );
    });

    it("uses the template's own text once edited", () => {
        expect(
            templatePrompt(
                { ...seedTemplate("general"), prompt: "Edited" },
                KIND,
            ),
        ).toBe("Edited");
    });
});

describe("resolveTemplate", () => {
    const config: TemplateConfiguration = {
        selectedPrompt: "c1",
        templates: [seedTemplate("general"), custom("c1"), custom("c2")],
    };

    it("uses the requested template", () => {
        expect(resolveTemplate(config, "c2", KIND).id).toBe("c2");
    });

    it("falls back to the user's default, not the hard-coded built-in", () => {
        expect(resolveTemplate(config, "deleted", KIND)).toEqual({
            id: "c1",
            prompt: "Mine c1 {transcription}",
        });
    });

    it("falls back to the built-in when the user has nothing usable", () => {
        const empty = { selectedPrompt: "x", templates: [custom("x", "  ")] };
        expect(resolveTemplate(empty, "x", KIND)).toEqual({
            id: "general",
            prompt: SUMMARY_PRESETS.general.prompt,
        });
    });

    it("resolves title templates the same way", () => {
        const titles = normalizeTemplateConfig(null, TITLE_TEMPLATE_KIND);
        const resolved = resolveTemplate(
            titles,
            titles.selectedPrompt,
            TITLE_TEMPLATE_KIND,
        );
        expect(resolved.id).toBe("default");
        expect(resolved.prompt).toContain("{transcription}");
    });
});

describe("saveTemplate", () => {
    const seeded = normalizeTemplateConfig(null, KIND);

    it("stores a built-in saved unchanged as null, so it keeps following the source", () => {
        const next = saveTemplate(
            seeded,
            {
                id: "general",
                name: "General Summary",
                prompt: `  ${SUMMARY_PRESETS.general.prompt}\n`,
            },
            KIND,
            { newId, builtinName: "General Summary" },
        );
        expect(next.templates[0]).toMatchObject({ name: null, prompt: null });
    });

    it("stores an edited built-in's text and name", () => {
        const next = saveTemplate(
            seeded,
            { id: "general", name: "Mine", prompt: "Edited {transcription}" },
            KIND,
            { newId, builtinName: "General Summary" },
        );
        expect(next.templates[0]).toMatchObject({
            id: "general",
            name: "Mine",
            prompt: "Edited {transcription}",
        });
    });

    it("reverting an edited built-in to the built-in text clears it again", () => {
        const edited = saveTemplate(
            seeded,
            { id: "general", name: "Mine", prompt: "Edited" },
            KIND,
            { newId, builtinName: "General Summary" },
        );
        const reverted = saveTemplate(
            edited,
            {
                id: "general",
                name: "General Summary",
                prompt: SUMMARY_PRESETS.general.prompt,
            },
            KIND,
            { newId, builtinName: "General Summary" },
        );
        expect(reverted.templates[0]).toMatchObject({
            name: null,
            prompt: null,
        });
    });

    it("appends a new template, trimmed, under a fresh id", () => {
        const next = saveTemplate(
            seeded,
            { name: " Standup ", prompt: " Do X {transcription} " },
            KIND,
            { newId },
        );
        expect(next.templates.at(-1)).toMatchObject({
            id: "new-1",
            name: "Standup",
            prompt: "Do X {transcription}",
        });
        expect(next.selectedPrompt).toBe("general");
    });

    it("never nulls a custom template's text, even if it matches a built-in", () => {
        const withCustom = { ...seeded, templates: [custom("c1")] };
        const next = saveTemplate(
            withCustom,
            {
                id: "c1",
                name: "Custom c1",
                prompt: SUMMARY_PRESETS.general.prompt,
            },
            KIND,
            { newId },
        );
        expect(next.templates[0].prompt).toBe(
            SUMMARY_PRESETS.general.prompt.trim(),
        );
    });
});

describe("deleteTemplate", () => {
    const config: TemplateConfiguration = {
        selectedPrompt: "c1",
        templates: [custom("c1"), custom("c2")],
    };

    it("moves the default role to the first remaining template", () => {
        expect(deleteTemplate(config, "c1")).toEqual({
            selectedPrompt: "c2",
            templates: [custom("c2")],
        });
    });

    it("leaves the default alone when another template is deleted", () => {
        expect(deleteTemplate(config, "c2").selectedPrompt).toBe("c1");
    });

    it("refuses to delete the last template", () => {
        const single = { selectedPrompt: "c1", templates: [custom("c1")] };
        expect(deleteTemplate(single, "c1")).toBe(single);
    });
});

describe("restoring deleted built-ins", () => {
    it("lists the missing ones and appends them unedited", () => {
        const config: TemplateConfiguration = {
            selectedPrompt: "c1",
            templates: [custom("c1"), seedTemplate("key-points")],
        };
        expect(missingPresetIds(config, KIND)).toEqual([
            "general",
            "meeting-notes",
            "action-items",
        ]);
        const restored = restoreMissingPresets(config, KIND);
        expect(restored.templates.map((t) => t.id)).toEqual([
            "c1",
            "key-points",
            "general",
            "meeting-notes",
            "action-items",
        ]);
        expect(missingPresetIds(restored, KIND)).toEqual([]);
    });
});

describe("isValidTemplateConfig", () => {
    it("accepts the template shape, with nulls on built-ins", () => {
        expect(
            isValidTemplateConfig(normalizeTemplateConfig(null, KIND), KIND),
        ).toBe(true);
    });

    it("still accepts the legacy shape", () => {
        expect(
            isValidTemplateConfig(
                { selectedPrompt: "general", customPrompts: [custom("c1")] },
                KIND,
            ),
        ).toBe(true);
    });

    it("rejects a null prompt or name on a template with no built-in behind it", () => {
        for (const field of ["prompt", "name"] as const) {
            expect(
                isValidTemplateConfig(
                    {
                        selectedPrompt: "c1",
                        templates: [{ ...custom("c1"), [field]: null }],
                    },
                    KIND,
                ),
            ).toBe(false);
        }
    });

    it("rejects duplicate ids", () => {
        expect(
            isValidTemplateConfig(
                {
                    selectedPrompt: "c1",
                    templates: [custom("c1"), custom("c1")],
                },
                KIND,
            ),
        ).toBe(false);
    });

    it("judges built-ins per kind", () => {
        // "general" is a summary built-in, not a title one.
        const config = {
            selectedPrompt: "general",
            templates: [seedTemplate("general")],
        };
        expect(isValidTemplateConfig(config, KIND)).toBe(true);
        expect(isValidTemplateConfig(config, TITLE_TEMPLATE_KIND)).toBe(false);
    });

    it("rejects primitives, null and a missing selectedPrompt", () => {
        for (const value of [null, "general", 42, { templates: [] }]) {
            expect(isValidTemplateConfig(value, KIND)).toBe(false);
        }
    });
});
