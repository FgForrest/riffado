import { isTranscriptionOnlyProvider } from "@/lib/ai/provider-presets";

export interface EnhancementCandidate {
    provider: string;
    isDefaultEnhancement: boolean;
}

/**
 * Pick the credential that should run summarization.
 *
 * Transcription-only providers (ElevenLabs, Google Gemini) have no
 * `chat/completions` surface, so they are never selected: picking one
 * would send the transcript to the wrong endpoint with the wrong key.
 * The user's enhancement default wins when it is usable, otherwise the
 * first usable credential does.
 */
export function pickEnhancementCredential<T extends EnhancementCandidate>(
    credentials: readonly T[],
): T | undefined {
    const usable = credentials.filter(
        (candidate) => !isTranscriptionOnlyProvider(candidate.provider),
    );
    return (
        usable.find((candidate) => candidate.isDefaultEnhancement) ?? usable[0]
    );
}

/**
 * The chat model to run enhancement with.
 *
 * The configured "default model" on a credential can be a Whisper
 * (transcription-only) id when the user only set up a transcription
 * provider. Pick a sane lightweight chat model per provider in that case so
 * enhancement still works.
 */
export function enhancementChatModel(credentials: {
    defaultModel: string | null;
    baseUrl: string | null;
}): string {
    const model = credentials.defaultModel || "gpt-4o-mini";
    if (!model.includes("whisper")) return model;
    const baseUrl = credentials.baseUrl || "";
    if (baseUrl.includes("groq")) return "llama-3.1-8b-instant";
    if (baseUrl.includes("together")) {
        return "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo";
    }
    if (baseUrl.includes("openrouter")) return "openai/gpt-4o-mini";
    return "gpt-4o-mini";
}
