/**
 * Prompt templates for topic detection. One built-in; users can edit it or
 * add their own, through the same template list as summaries and titles.
 *
 * The template sets the style -- how many topics, how titles read. The reply
 * format and the rule that starts must be copied from the transcript live in
 * `TOPIC_SYSTEM_PROMPT`, which no template can override: the anchoring code
 * depends on them.
 */

import {
    isValidTemplateConfig,
    normalizeTemplateConfig,
    type TemplateConfiguration,
    type TemplateKind,
} from "@/lib/ai/prompt-templates";

export type TopicPreset = "default";

export const TOPIC_PRESETS: Readonly<Record<TopicPreset, { prompt: string }>> =
    {
        default: {
            prompt: `Divide this conversation into its topics, as chapters of a recording someone will want to jump around in.

Guidelines:
- Start a new topic where the conversation clearly moves to a different subject, not at every change of speaker.
- Aim for a topic every few minutes; a short recording may have only two or three. Do not create a topic shorter than about a minute unless the subject really changes.
- The first topic starts where the conversation starts.
- Titles are short noun phrases of two to six words that name what is discussed, like chapter titles. No numbering, no speaker names unless they are the subject, no ending punctuation.

Transcript:
{transcription}`,
        },
    };

export const TOPIC_TEMPLATE_KIND: TemplateKind<TopicPreset> = {
    presets: TOPIC_PRESETS,
    fallbackId: "default",
};

/**
 * The reply contract. In the system message, so an edited template cannot
 * drop it.
 */
export const TOPIC_SYSTEM_PROMPT = `You split transcripts of recorded conversations into topics.

Each line of the transcript begins with a time in square brackets. A line without a speaker name continues the previous speaker.

Reply with one raw JSON object and nothing else, no code fences and no text around it:
{"topics": [{"start": "03:42", "title": "..."}]}

"start" must be copied exactly from the square brackets of the line where the topic begins. Never compute, round or invent a time. List topics in the order they occur.`;

/** Read a stored (decrypted) `topicPrompt`; see normalizeTemplateConfig. */
export function normalizeTopicPromptConfig(
    raw: unknown,
): TemplateConfiguration {
    return normalizeTemplateConfig(raw, TOPIC_TEMPLATE_KIND);
}

/** Validate an untrusted `topicPrompt`; see isValidTemplateConfig. */
export function isValidTopicPromptConfig(value: unknown): boolean {
    return isValidTemplateConfig(value, TOPIC_TEMPLATE_KIND);
}
