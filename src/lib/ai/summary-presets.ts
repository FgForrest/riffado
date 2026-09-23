import {
    defaultTemplateConfig,
    isValidTemplateConfig,
    normalizeTemplateConfig,
    type TemplateConfiguration,
    type TemplateKind,
} from "./prompt-templates";

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

/** Summary templates are the shared prompt-template model. */
export type SummaryPromptConfiguration = TemplateConfiguration;

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

export const SUMMARY_TEMPLATE_KIND: TemplateKind<SummaryPreset> = {
    presets: SUMMARY_PRESETS,
    fallbackId: "general",
};

export function getDefaultSummaryPromptConfig(): SummaryPromptConfiguration {
    return defaultTemplateConfig(SUMMARY_TEMPLATE_KIND);
}

/** Read a stored (decrypted) `summaryPrompt` value; see normalizeTemplateConfig. */
export function normalizeSummaryPromptConfig(
    raw: unknown,
): SummaryPromptConfiguration {
    return normalizeTemplateConfig(raw, SUMMARY_TEMPLATE_KIND);
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

/**
 * What the model reads to find the language under `auto`: the transcription
 * itself, or -- for the multi-pass merge, which never sees the transcription
 * -- the extractions produced from it.
 */
export type LanguageSource = "transcription" | "extractions";

/**
 * Directive for the model's output language.
 *
 * `auto` (and a missing or unknown code) gets a directive too, not silence:
 * every prompt is written in English, and a model left to itself answers a
 * Czech transcript in English, or in Czech under the English "###" headings
 * the preset named. A chosen language has the same heading problem, so both
 * share the rules after the first sentence. The speaker placeholders are
 * exempted by name because `speaker-references.ts` resolves only the English
 * `[Speaker N]` form.
 */
export function getAiOutputLanguageDirective(
    code: string | null | undefined,
    source: LanguageSource = "transcription",
): string {
    const match =
        code && code !== "auto"
            ? AI_OUTPUT_LANGUAGES.find((l) => l.code === code)
            : undefined;
    const rules =
        "That includes every heading, label, and example wording these instructions give in English: write it in that language rather than copying it. Keep names and technical terms as they were spoken. Keep any JSON keys in English exactly as specified, and keep speaker references such as [Speaker 1](#speaker-1) exactly as written.";
    if (match) {
        return `IMPORTANT: Write all natural-language output in ${match.label}, regardless of the transcription's language. ${rules}`;
    }
    const target =
        source === "extractions"
            ? "the language the extractions are written in, which is the language of the transcription they came from"
            : "the language the transcription is predominantly spoken in";
    return `IMPORTANT: Write all natural-language output in ${target}, even though these instructions are written in English. ${rules} Follow a different output language only if the user's instructions explicitly ask for one.`;
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

/** Stable speaker references that can be projected after attribution. */
export const SUMMARY_SPEAKER_DIRECTIVE = `SPEAKER REFERENCES:

- Never infer, guess, or invent a speaker's name, identity, or role from context. Do not replace an anonymous speaker label even when the identity seems obvious.
- Whenever referring to transcript label speaker_N, write exactly [Speaker N](#speaker-N), using the same number. Apply this in summary, keyPoints, and actionItems.
- Preserve these Markdown references exactly during rewriting or merging. They are stable placeholders that Riffado resolves only after the user confirms an attribution.`;

/** Validate an untrusted `summaryPrompt` payload; see isValidTemplateConfig. */
export function isValidSummaryPromptConfig(value: unknown): boolean {
    return isValidTemplateConfig(value, SUMMARY_TEMPLATE_KIND);
}
