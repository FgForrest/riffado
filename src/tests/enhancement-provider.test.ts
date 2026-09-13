import { describe, expect, it } from "vitest";
import { pickEnhancementCredential } from "@/lib/ai/enhancement-provider";

describe("pickEnhancementCredential", () => {
    it("prefers the enhancement default among providers that can summarize", () => {
        const picked = pickEnhancementCredential([
            { id: "a", provider: "Groq", isDefaultEnhancement: false },
            { id: "b", provider: "OpenAI", isDefaultEnhancement: true },
        ]);

        expect(picked?.id).toBe("b");
    });

    it("never picks a transcription-only provider, even when flagged as the default", () => {
        const picked = pickEnhancementCredential([
            { id: "a", provider: "ElevenLabs", isDefaultEnhancement: true },
            { id: "b", provider: "Groq", isDefaultEnhancement: false },
        ]);

        expect(picked?.id).toBe("b");
    });

    it("skips transcription-only providers when falling back", () => {
        const picked = pickEnhancementCredential([
            { id: "a", provider: "Google Gemini", isDefaultEnhancement: false },
            { id: "b", provider: "OpenAI", isDefaultEnhancement: false },
        ]);

        expect(picked?.id).toBe("b");
    });

    it("returns undefined when every provider is transcription-only", () => {
        const picked = pickEnhancementCredential([
            { id: "a", provider: "ElevenLabs", isDefaultEnhancement: false },
            { id: "b", provider: "Google Gemini", isDefaultEnhancement: true },
        ]);

        expect(picked).toBeUndefined();
    });

    it("treats unknown providers as capable", () => {
        const picked = pickEnhancementCredential([
            { id: "a", provider: "Custom", isDefaultEnhancement: false },
        ]);

        expect(picked?.id).toBe("a");
    });

    it("returns undefined for an empty list", () => {
        expect(pickEnhancementCredential([])).toBeUndefined();
    });
});
