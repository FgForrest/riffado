export type TranscriptionStyle = "whisper" | "chat" | "gemini" | "elevenlabs";

export interface ProviderPreset {
    name: string;
    baseUrl: string;
    placeholder: string;
    defaultModel: string;
    transcriptionStyle: TranscriptionStyle;
    fetchAudioModels?: boolean;
    knownTranscriptionModels?: readonly string[];
    /** Friendlier dropdown labels for ids in `knownTranscriptionModels`. */
    modelLabels?: Readonly<Record<string, string>>;
    /** Provider has no chat/completions surface, so it cannot summarize. */
    transcriptionOnly?: boolean;
    /**
     * Provider speaks `chat/completions` but takes no audio input, so it
     * can summarize and title but never transcribe. The mirror image of
     * `transcriptionOnly`; the two are mutually exclusive.
     */
    enhancementOnly?: boolean;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
    {
        name: "OpenAI",
        baseUrl: "",
        placeholder: "sk-...",
        defaultModel: "whisper-1",
        transcriptionStyle: "whisper",
        knownTranscriptionModels: [
            "whisper-1",
            "gpt-4o-transcribe",
            "gpt-4o-mini-transcribe",
            "gpt-4o-transcribe-diarize",
        ],
    },
    {
        name: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        placeholder: "gsk_...",
        defaultModel: "whisper-large-v3-turbo",
        transcriptionStyle: "whisper",
        knownTranscriptionModels: [
            "whisper-large-v3-turbo",
            "whisper-large-v3",
        ],
    },
    {
        name: "Together AI",
        baseUrl: "https://api.together.xyz/v1",
        placeholder: "...",
        defaultModel: "openai/whisper-large-v3",
        transcriptionStyle: "whisper",
        knownTranscriptionModels: [
            "openai/whisper-large-v3",
            "nvidia/parakeet-tdt-0.6b-v3",
        ],
    },
    {
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        placeholder: "sk-or-...",
        defaultModel: "google/gemini-2.5-flash-lite",
        transcriptionStyle: "chat",
        fetchAudioModels: true,
    },
    {
        name: "LM Studio",
        baseUrl: "http://localhost:1234/v1",
        placeholder: "lm-studio",
        defaultModel: "",
        transcriptionStyle: "whisper",
    },
    {
        name: "Ollama",
        baseUrl: "http://localhost:11434/v1",
        placeholder: "ollama",
        defaultModel: "",
        transcriptionStyle: "whisper",
    },
    {
        name: "Google Gemini",
        baseUrl: "",
        placeholder: "AIza...",
        defaultModel: "gemini-2.0-flash",
        transcriptionStyle: "gemini",
        transcriptionOnly: true,
        knownTranscriptionModels: [
            "gemini-2.0-flash",
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-1.5-flash",
            "gemini-1.5-pro",
        ],
    },
    {
        name: "ElevenLabs",
        baseUrl: "",
        placeholder: "sk_...",
        defaultModel: "scribe_v2",
        transcriptionStyle: "elevenlabs",
        transcriptionOnly: true,
        knownTranscriptionModels: [
            "scribe_v2",
            "scribe_v2+diarize",
            "scribe_v2_medical",
            "scribe_v1",
        ],
        modelLabels: {
            "scribe_v2+diarize": "scribe_v2 (speaker labels)",
        },
    },
    // Both agent CLIs are reached through the bridge sidecar in
    // `agent-bridge/`, which re-wraps `chat/completions` onto `claude -p`
    // and `codex exec` so a subscription can drive summaries instead of a
    // metered API key. They share one base URL and are told apart by the
    // model id. The API key is the bridge's own `BRIDGE_TOKEN`, not a
    // vendor key -- the subscription credential never leaves the sidecar.
    //
    // `defaultModel` is a routing hint the bridge passes through to the
    // CLI verbatim, so the usable set tracks whatever the installed CLI
    // supports rather than a list Riffado has to keep current. That is
    // also why neither preset carries `knownTranscriptionModels`: the
    // picker falls back to a freeform field.
    {
        name: "Claude Code",
        baseUrl: "http://agent-bridge:8787/v1",
        placeholder: "bridge token",
        defaultModel: "claude-sonnet-5",
        transcriptionStyle: "whisper",
        enhancementOnly: true,
    },
    {
        name: "Codex",
        baseUrl: "http://agent-bridge:8787/v1",
        placeholder: "bridge token",
        defaultModel: "gpt-5-codex",
        transcriptionStyle: "whisper",
        enhancementOnly: true,
    },
    {
        name: "Custom",
        baseUrl: "",
        placeholder: "Your API key",
        defaultModel: "",
        transcriptionStyle: "whisper",
    },
] as const;

// Presets whose base URL is a private address the hosted app cannot
// reach: loopback for LM Studio / Ollama, a compose service name for the
// agent bridge. Hidden from the hosted provider picker. Only the loopback
// ones are also rejected server-side by `validateAiBaseUrl` -- a compose
// service name is a syntactically ordinary host, so the bridge presets
// rely on this list alone. That is cosmetic, not a control: on hosted
// the name simply does not resolve.
export const LOCAL_PRESET_NAMES: ReadonlySet<string> = new Set([
    "LM Studio",
    "Ollama",
    "Claude Code",
    "Codex",
]);

export function getVisiblePresets({
    isHosted,
}: {
    isHosted: boolean;
}): readonly ProviderPreset[] {
    if (!isHosted) return PROVIDER_PRESETS;
    return PROVIDER_PRESETS.filter((p) => !LOCAL_PRESET_NAMES.has(p.name));
}

export function findPreset(name: string): ProviderPreset | undefined {
    return PROVIDER_PRESETS.find((p) => p.name === name);
}

export function isLocalPreset(name: string): boolean {
    return LOCAL_PRESET_NAMES.has(name);
}

export function getTranscriptionStyle(
    providerName: string,
): TranscriptionStyle {
    return findPreset(providerName)?.transcriptionStyle ?? "whisper";
}

/**
 * Preset default model for a provider, used when a stored credential has
 * no model of its own. Empty for presets without a curated default.
 */
export function getDefaultTranscriptionModel(providerName: string): string {
    return findPreset(providerName)?.defaultModel ?? "";
}

/**
 * True for providers that transcribe but cannot summarize, because they
 * expose no `chat/completions` surface. Unknown providers are assumed
 * capable: a self-hoster's custom endpoint usually is.
 */
export function isTranscriptionOnlyProvider(providerName: string): boolean {
    return findPreset(providerName)?.transcriptionOnly === true;
}

/**
 * True for providers that summarize but cannot transcribe, because they
 * take no audio input -- the agent CLIs behind the bridge sidecar. Unknown
 * providers are assumed capable, matching `isTranscriptionOnlyProvider`.
 *
 * Only the three write paths that can point transcription at a credential
 * consult this (`POST`/`PUT /api/settings/ai/providers`, `PUT
 * .../default-transcription`). The runtime path in `transcribe-recording.ts`
 * needs no guard: it resolves a provider from
 * `userSettings.defaultTranscriptionProviderId` or an explicit
 * `isDefaultTranscription` row and never falls back to "any credential",
 * so an enhancement-only provider can only be reached by first passing
 * through one of those three.
 */
export function isEnhancementOnlyProvider(providerName: string): boolean {
    return findPreset(providerName)?.enhancementOnly === true;
}
