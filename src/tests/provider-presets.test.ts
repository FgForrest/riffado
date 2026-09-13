import { describe, expect, it } from "vitest";
import {
    findPreset,
    getDefaultTranscriptionModel,
    getVisiblePresets,
    isEnhancementOnlyProvider,
    isLocalPreset,
    isTranscriptionOnlyProvider,
    LOCAL_PRESET_NAMES,
    PROVIDER_PRESETS,
} from "@/lib/ai/provider-presets";

describe("provider-presets", () => {
    describe("visibility", () => {
        it("shows all presets on self-host and only non-local presets on hosted", () => {
            expect(getVisiblePresets({ isHosted: false })).toEqual(
                PROVIDER_PRESETS,
            );
            expect(getVisiblePresets({ isHosted: true })).toEqual(
                PROVIDER_PRESETS.filter((p) => !LOCAL_PRESET_NAMES.has(p.name)),
            );
        });
    });

    describe("isLocalPreset", () => {
        it("matches LOCAL_PRESET_NAMES", () => {
            for (const preset of PROVIDER_PRESETS) {
                expect(isLocalPreset(preset.name)).toBe(
                    LOCAL_PRESET_NAMES.has(preset.name),
                );
            }
        });
    });

    describe("findPreset", () => {
        it("returns the preset by name", () => {
            expect(findPreset("OpenAI")?.defaultModel).toBe("whisper-1");
            expect(findPreset("Ollama")?.baseUrl).toBe(
                "http://localhost:11434/v1",
            );
        });

        it("returns undefined for an unknown name", () => {
            expect(findPreset("Nope")).toBeUndefined();
        });
    });

    describe("knownTranscriptionModels", () => {
        it("Together AI uses the correct prefixed Whisper id", () => {
            const preset = findPreset("Together AI");
            expect(preset?.defaultModel).toBe("openai/whisper-large-v3");
            expect(preset?.knownTranscriptionModels).toContain(
                "openai/whisper-large-v3",
            );
        });

        it("local + custom presets have no curated list (freeform input)", () => {
            expect(
                findPreset("LM Studio")?.knownTranscriptionModels,
            ).toBeUndefined();
            expect(
                findPreset("Ollama")?.knownTranscriptionModels,
            ).toBeUndefined();
            expect(
                findPreset("Custom")?.knownTranscriptionModels,
            ).toBeUndefined();
        });

        it("every defaultModel appears in its preset's known list when one exists", () => {
            for (const p of PROVIDER_PRESETS) {
                if (!p.knownTranscriptionModels) continue;
                expect(p.knownTranscriptionModels).toContain(p.defaultModel);
            }
        });

        it("every modelLabels key is an id the preset actually offers", () => {
            for (const p of PROVIDER_PRESETS) {
                if (!p.modelLabels) continue;
                for (const id of Object.keys(p.modelLabels)) {
                    expect(p.knownTranscriptionModels).toContain(id);
                }
            }
        });
    });

    describe("ElevenLabs", () => {
        it("uses the native Scribe style and no base URL", () => {
            const preset = findPreset("ElevenLabs");
            expect(preset?.transcriptionStyle).toBe("elevenlabs");
            expect(preset?.baseUrl).toBe("");
            expect(preset?.defaultModel).toBe("scribe_v2");
        });

        it("offers diarization as a model variant", () => {
            const preset = findPreset("ElevenLabs");
            expect(preset?.knownTranscriptionModels).toContain(
                "scribe_v2+diarize",
            );
            expect(preset?.modelLabels?.["scribe_v2+diarize"]).toBe(
                "scribe_v2 (speaker labels)",
            );
        });
    });

    describe("isTranscriptionOnlyProvider", () => {
        it("flags the providers with no chat/completions surface", () => {
            expect(isTranscriptionOnlyProvider("ElevenLabs")).toBe(true);
            expect(isTranscriptionOnlyProvider("Google Gemini")).toBe(true);
        });

        it("leaves OpenAI-compatible and unknown providers usable", () => {
            expect(isTranscriptionOnlyProvider("OpenAI")).toBe(false);
            expect(isTranscriptionOnlyProvider("OpenRouter")).toBe(false);
            expect(isTranscriptionOnlyProvider("Custom")).toBe(false);
            expect(isTranscriptionOnlyProvider("Nope")).toBe(false);
        });
    });

    describe("isEnhancementOnlyProvider", () => {
        it("flags the agent CLIs reached through the bridge", () => {
            expect(isEnhancementOnlyProvider("Claude Code")).toBe(true);
            expect(isEnhancementOnlyProvider("Codex")).toBe(true);
        });

        it("leaves audio-capable and unknown providers usable", () => {
            expect(isEnhancementOnlyProvider("OpenAI")).toBe(false);
            expect(isEnhancementOnlyProvider("ElevenLabs")).toBe(false);
            expect(isEnhancementOnlyProvider("Custom")).toBe(false);
            expect(isEnhancementOnlyProvider("Nope")).toBe(false);
        });

        it("is never set together with transcriptionOnly", () => {
            for (const p of PROVIDER_PRESETS) {
                expect(p.transcriptionOnly && p.enhancementOnly).toBeFalsy();
            }
        });
    });

    describe("agent bridge presets", () => {
        // Both CLIs are served by the one `agent-bridge` sidecar and told
        // apart by model id, so a drift in either base URL would silently
        // point one of them at nothing.
        it("share the bridge base URL", () => {
            expect(findPreset("Claude Code")?.baseUrl).toBe(
                "http://agent-bridge:8787/v1",
            );
            expect(findPreset("Codex")?.baseUrl).toBe(
                "http://agent-bridge:8787/v1",
            );
        });

        it("are hidden on hosted, where the bridge is unreachable", () => {
            const hostedNames = getVisiblePresets({ isHosted: true }).map(
                (p) => p.name,
            );
            expect(hostedNames).not.toContain("Claude Code");
            expect(hostedNames).not.toContain("Codex");
            expect(isLocalPreset("Claude Code")).toBe(true);
            expect(isLocalPreset("Codex")).toBe(true);
        });

        it("carry a default model that survives the summarizer's whisper rewrite", () => {
            // `generateSummaryForRecording` rewrites any model whose id
            // contains "whisper" to a chat model, assuming the credential
            // was set up for transcription. A bridge default that tripped
            // that would be swapped out for `gpt-4o-mini` and never reach
            // the CLI.
            for (const name of ["Claude Code", "Codex"]) {
                const model = findPreset(name)?.defaultModel ?? "";
                expect(model).not.toBe("");
                expect(model).not.toContain("whisper");
            }
        });
    });

    describe("getDefaultTranscriptionModel", () => {
        it("returns the preset default and empty for unknown providers", () => {
            expect(getDefaultTranscriptionModel("ElevenLabs")).toBe(
                "scribe_v2",
            );
            expect(getDefaultTranscriptionModel("OpenAI")).toBe("whisper-1");
            expect(getDefaultTranscriptionModel("Nope")).toBe("");
        });
    });
});
