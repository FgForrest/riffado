import { describe, expect, it } from "vitest";
import { resolveTemplate } from "@/lib/ai/prompt-templates";
import {
    isValidSummaryPromptConfig,
    normalizeSummaryPromptConfig,
    SUMMARY_TEMPLATE_KIND,
} from "@/lib/ai/summary-presets";

// Regression coverage for #199: custom summary prompts were unreachable in
// the UI, and the one path that could write them (`PUT /api/settings/user`)
// accepted any shape and silently wiped `customPrompts` on every preset
// change. These tests cover the shape validator added to close that gap and
// that custom prompts saved in that legacy shape survive the move to
// editable templates.
describe("isValidSummaryPromptConfig", () => {
    it("accepts a well-formed config with no custom prompts", () => {
        expect(
            isValidSummaryPromptConfig({
                selectedPrompt: "general",
                customPrompts: [],
            }),
        ).toBe(true);
    });

    it("accepts a well-formed config with custom prompts", () => {
        expect(
            isValidSummaryPromptConfig({
                selectedPrompt: "custom-1",
                customPrompts: [
                    {
                        id: "custom-1",
                        name: "Recording Type Detector",
                        prompt: "Detect the type... {transcription}",
                        createdAt: "2026-01-01T00:00:00.000Z",
                    },
                ],
            }),
        ).toBe(true);
    });

    it("rejects a missing selectedPrompt", () => {
        expect(isValidSummaryPromptConfig({ customPrompts: [] })).toBe(false);
    });

    it("rejects a non-array customPrompts", () => {
        expect(
            isValidSummaryPromptConfig({
                selectedPrompt: "general",
                customPrompts: "not-an-array",
            }),
        ).toBe(false);
    });

    it("rejects a custom prompt entry missing required fields", () => {
        expect(
            isValidSummaryPromptConfig({
                selectedPrompt: "custom-1",
                customPrompts: [{ id: "custom-1", name: "Missing prompt" }],
            }),
        ).toBe(false);
    });

    it("rejects primitives and null", () => {
        expect(isValidSummaryPromptConfig(null)).toBe(false);
        expect(isValidSummaryPromptConfig("general")).toBe(false);
        expect(isValidSummaryPromptConfig(42)).toBe(false);
    });
});

describe("legacy custom prompts after the move to templates", () => {
    const legacy = {
        selectedPrompt: "custom-1",
        customPrompts: [
            {
                id: "custom-1",
                name: "My Custom Prompt",
                prompt: "Custom instructions {transcription}",
                createdAt: "2026-01-01T00:00:00.000Z",
            },
        ],
    };

    it("reads as the built-ins followed by the custom prompts", () => {
        const config = normalizeSummaryPromptConfig(legacy);
        expect(config.templates.map((t) => t.id)).toEqual([
            "general",
            "meeting-notes",
            "key-points",
            "action-items",
            "custom-1",
        ]);
        expect(config.templates.at(-1)?.name).toBe("My Custom Prompt");
        expect(config.selectedPrompt).toBe("custom-1");
    });

    it("resolves a custom prompt id from the config", () => {
        const config = normalizeSummaryPromptConfig(legacy);
        expect(
            resolveTemplate(config, "custom-1", SUMMARY_TEMPLATE_KIND),
        ).toEqual({
            id: "custom-1",
            prompt: "Custom instructions {transcription}",
        });
    });

    it("falls back to the user's default for a deleted id, and says so", () => {
        const config = normalizeSummaryPromptConfig(legacy);
        const resolved = resolveTemplate(
            config,
            "deleted-custom-id",
            SUMMARY_TEMPLATE_KIND,
        );
        expect(resolved.id).toBe("custom-1");
    });
});
