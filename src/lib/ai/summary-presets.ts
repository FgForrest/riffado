export type SummaryPreset =
    | "general"
    | "meeting-notes"
    | "key-points"
    | "action-items";

export interface SummaryPromptConfig {
    id: SummaryPreset;
    name: string;
    description: string;
    prompt: string;
}

export interface CustomSummaryPrompt {
    id: string;
    name: string;
    prompt: string;
    createdAt: string;
}

export interface SummaryPromptConfiguration {
    /** Preset id or custom prompt id. */
    selectedPrompt: string;
    customPrompts: CustomSummaryPrompt[];
}

export const SUMMARY_PRESETS: Record<SummaryPreset, SummaryPromptConfig> = {
    general: {
        id: "general",
        name: "General Summary",
        description: "Concise summary of any audio transcription",
        prompt: `Summarize this audio transcription, then extract key points and action items if any exist.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A Markdown summary of the transcription",
  "keyPoints": ["key point 1", "key point 2"],
  "actionItems": ["action item 1", "action item 2"]
}

Match the summary to the recording. A short or single-topic recording wants one tight paragraph. A long one that moves through several distinct topics is far easier to read as a short opening paragraph followed by a "###" section per topic, so use that shape when the recording earns it.

If there are no key points or action items, return empty arrays.

Transcription:
{transcription}`,
    },
    "meeting-notes": {
        id: "meeting-notes",
        name: "Meeting Notes",
        description:
            "Structured meeting summary with attendees, decisions, and action items",
        prompt: `Summarize this meeting recording. Include attendees mentioned, decisions made, and action items.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A Markdown summary of the meeting",
  "keyPoints": ["decision 1", "decision 2", "key discussion point"],
  "actionItems": ["action item with owner if mentioned", "follow-up task"]
}

Write the summary as "###" sections, using only the ones this meeting actually supports: Attendees, Purpose, Discussion, Open questions. Leave a section out entirely rather than writing "None" under it. List attendees as bullets once there are more than two, with their role or team when it was mentioned.

The decisions belong in keyPoints and the tasks in actionItems, so the summary covers who met, what it was about, and how the discussion went, not a second copy of those two lists.

If there are no key points or action items, return empty arrays.

Transcription:
{transcription}`,
    },
    "key-points": {
        id: "key-points",
        name: "Key Points",
        description: "Extract the key points as a bullet list",
        prompt: `Extract the key points from this transcription. Focus on the most important information, facts, and insights.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A brief one-sentence overview of the transcription",
  "keyPoints": ["key point 1", "key point 2", "key point 3"],
  "actionItems": []
}

Transcription:
{transcription}`,
    },
    "action-items": {
        id: "action-items",
        name: "Action Items",
        description:
            "Extract all action items, tasks, and follow-ups mentioned",
        prompt: `Extract all action items, tasks, and follow-ups mentioned in this transcription. Include who is responsible if mentioned.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A brief overview of what was discussed",
  "keyPoints": [],
  "actionItems": ["action item 1 (owner if known)", "task 2", "follow-up 3"]
}

If there are no action items, return an empty array but still provide a summary.

Transcription:
{transcription}`,
    },
};

export function getSummaryPromptForPreset(preset: SummaryPreset): string {
    return SUMMARY_PRESETS[preset].prompt;
}

export function getDefaultSummaryPromptConfig(): SummaryPromptConfiguration {
    return {
        selectedPrompt: "general",
        customPrompts: [],
    };
}

export function getAllSummaryPrompts(
    config: SummaryPromptConfiguration,
): Array<{
    id: string;
    name: string;
    description: string;
    prompt: string;
    isPreset: boolean;
}> {
    const presets = Object.values(SUMMARY_PRESETS).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        prompt: p.prompt,
        isPreset: true,
    }));

    const customs = config.customPrompts.map((p) => ({
        id: p.id,
        name: p.name,
        description: "Custom prompt",
        prompt: p.prompt,
        isPreset: false,
    }));

    return [...presets, ...customs];
}

export interface AiOutputLanguageOption {
    code: string;
    label: string;
}

export const AI_OUTPUT_LANGUAGES: readonly AiOutputLanguageOption[] = [
    { code: "auto", label: "Auto (match transcript)" },
    { code: "en", label: "English" },
    { code: "es", label: "Spanish" },
    { code: "fr", label: "French" },
    { code: "de", label: "German" },
    { code: "it", label: "Italian" },
    { code: "pt", label: "Portuguese" },
    { code: "nl", label: "Dutch" },
    { code: "pl", label: "Polish" },
    { code: "ru", label: "Russian" },
    { code: "tr", label: "Turkish" },
    { code: "uk", label: "Ukrainian" },
    { code: "cs", label: "Czech" },
    { code: "sv", label: "Swedish" },
    { code: "da", label: "Danish" },
    { code: "no", label: "Norwegian" },
    { code: "fi", label: "Finnish" },
    { code: "el", label: "Greek" },
    { code: "ro", label: "Romanian" },
    { code: "hu", label: "Hungarian" },
    { code: "ja", label: "Japanese" },
    { code: "zh", label: "Chinese (Simplified)" },
    { code: "ko", label: "Korean" },
    { code: "ar", label: "Arabic" },
    { code: "he", label: "Hebrew" },
    { code: "hi", label: "Hindi" },
    { code: "id", label: "Indonesian" },
    { code: "vi", label: "Vietnamese" },
    { code: "th", label: "Thai" },
] as const;

const LANGUAGE_CODES = new Set(AI_OUTPUT_LANGUAGES.map((l) => l.code));

/** Validate against `AI_OUTPUT_LANGUAGES`; returns the code or null. */
export function normalizeAiOutputLanguage(value: unknown): string | null {
    if (typeof value !== "string") return null;
    return LANGUAGE_CODES.has(value) ? value : null;
}

/** Directive sentence for the model; null for `auto`/missing/unknown. */
export function getAiOutputLanguageDirective(
    code: string | null | undefined,
): string | null {
    if (!code || code === "auto") return null;
    const match = AI_OUTPUT_LANGUAGES.find((l) => l.code === code);
    if (!match) return null;
    return `IMPORTANT: Write all natural-language output in ${match.label}, regardless of the transcription's language. Keep any JSON keys in English exactly as specified.`;
}

/**
 * Appended to every summary prompt, including custom ones.
 *
 * Carries the rules that hold regardless of which prompt asked for the
 * summary, so the presets do not restate them and a prompt the user wrote
 * gets them too. A user-written prompt is in fact the one most likely to
 * still carry the old "no markdown" wording, which models read as applying to
 * the prose and not just to the envelope.
 */
export const SUMMARY_MARKDOWN_DIRECTIVE = `FORMATTING: the "summary" value is rendered as Markdown.

- Use formatting only where it earns its place: bullets for a genuine list, bold for a term the reader should catch, "###" headings when the recording really does cover several distinct topics. A short summary reads better as one plain paragraph. Never impose structure the recording does not have, and never open a heading above level 3.
- Do not restate the key points or action items as a list inside "summary". They are rendered as their own lists directly beneath it, so a copy there is read twice. Referring to them in prose is fine.
- Key points and action items are rendered as Markdown as well, but each is already one entry in a list, so keep each to a single line and do not give it a bullet marker of its own.
- The reply itself is still one raw JSON object: escape newlines inside strings as \\n, and do not wrap the object in code fences.`;

export function getSummaryPromptById(
    id: string,
    config: SummaryPromptConfiguration,
): string | null {
    if (id in SUMMARY_PRESETS) {
        return SUMMARY_PRESETS[id as SummaryPreset].prompt;
    }

    const custom = config.customPrompts.find((p) => p.id === id);
    return custom?.prompt || null;
}

/**
 * Validate an untrusted `summaryPrompt` payload before it's encrypted and
 * stored. Only shape is checked (strings where expected, array of
 * well-formed custom-prompt entries) -- this is user-owned settings data,
 * not a cross-user boundary, but a malformed value would otherwise be
 * silently encrypted and only surface as a broken dropdown or a crash in
 * `getAllSummaryPrompts` on the next read.
 */
export function isValidSummaryPromptConfig(
    value: unknown,
): value is SummaryPromptConfiguration {
    if (typeof value !== "object" || value === null) return false;
    const config = value as Record<string, unknown>;
    if (typeof config.selectedPrompt !== "string") return false;
    if (!Array.isArray(config.customPrompts)) return false;
    return config.customPrompts.every(
        (p) =>
            typeof p === "object" &&
            p !== null &&
            typeof (p as Record<string, unknown>).id === "string" &&
            typeof (p as Record<string, unknown>).name === "string" &&
            typeof (p as Record<string, unknown>).prompt === "string" &&
            typeof (p as Record<string, unknown>).createdAt === "string",
    );
}
