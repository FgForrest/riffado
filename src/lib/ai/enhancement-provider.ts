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
