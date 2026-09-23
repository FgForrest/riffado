import { and, eq } from "drizzle-orm";
import { OpenAI } from "openai";
import { db } from "@/db";
import { apiCredentials, userSettings } from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import { decryptJsonField } from "@/lib/encryption/fields";
import { buildChatCompletionParams } from "./chat-completion-params";
import {
    normalizeTitlePromptConfig,
    TITLE_TEMPLATE_KIND,
} from "./prompt-presets";
import { resolveTemplate } from "./prompt-templates";
import { getAiOutputLanguageDirective } from "./summary-presets";

export async function generateTitleFromTranscription(
    userId: string,
    transcriptionText: string,
): Promise<string | null> {
    try {
        // Get user's prompt configuration
        const [userSettingsRow] = await db
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);

        // `titleGenerationPrompt` is jsonb-envelope encrypted at rest;
        // legacy plaintext rows pass through verbatim. A missing value reads
        // as the seeded built-ins.
        const promptConfig = normalizeTitlePromptConfig(
            userSettingsRow?.titleGenerationPrompt
                ? decryptJsonField(userSettingsRow.titleGenerationPrompt)
                : null,
        );
        const { prompt: promptTemplate } = resolveTemplate(
            promptConfig,
            promptConfig.selectedPrompt,
            TITLE_TEMPLATE_KIND,
        );

        // Get user's AI credentials (prefer enhancement provider, fallback to any configured provider)
        const [enhancementCredentials] = await db
            .select()
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.userId, userId),
                    eq(apiCredentials.isDefaultEnhancement, true),
                ),
            )
            .limit(1);

        const [fallbackCredentials] = await db
            .select()
            .from(apiCredentials)
            .where(eq(apiCredentials.userId, userId))
            .orderBy(apiCredentials.createdAt)
            .limit(1);

        // Prefer enhancement provider, fallback to any configured provider
        const credentials = enhancementCredentials || fallbackCredentials;

        if (!credentials) {
            console.warn("No AI provider found for title generation");
            return null;
        }

        // Decrypt API key
        const apiKey = decrypt(credentials.apiKey);

        // Create OpenAI client
        const openai = new OpenAI({
            apiKey,
            baseURL: credentials.baseUrl || undefined,
        });

        // Use a lightweight model for title generation
        // Prefer chat models (gpt-4o-mini, gpt-3.5-turbo) over Whisper models
        // Fallback to default model if no specific model is set
        let model = credentials.defaultModel || "gpt-4o-mini";

        // If the model is a Whisper model (for transcription), use a chat model instead
        if (model.includes("whisper") || model.includes("whisper-")) {
            model = "gpt-4o-mini";
        }

        // Truncate transcription if too long (to save tokens)
        const maxTranscriptionLength = 2000;
        const truncatedTranscription =
            transcriptionText.length > maxTranscriptionLength
                ? `${transcriptionText.substring(0, maxTranscriptionLength)}...`
                : transcriptionText;

        // Apply the AI output language directive via the system
        // message rather than the user prompt, so it doesn't compete with
        // the title-format rules in the user prompt.
        const languageDirective = getAiOutputLanguageDirective(
            userSettingsRow?.aiOutputLanguage ?? null,
        );

        // Replacement function so `$` sequences in the transcript are
        // inserted verbatim, not treated as `String.prototype.replace`
        // special patterns.
        const prompt = promptTemplate.replace(
            "{transcription}",
            () => truncatedTranscription,
        );

        const baseSystem =
            "You are a helpful assistant that generates concise, descriptive titles for audio recordings based on transcriptions. Always follow the rules strictly.";
        const systemContent = `${baseSystem} ${languageDirective}`;

        const response = await openai.chat.completions.create(
            buildChatCompletionParams({
                model,
                messages: [
                    {
                        role: "system",
                        content: systemContent,
                    },
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
                temperature: 0.7,
                maxTokens: 50, // Titles should be short
            }),
        );

        const title = response.choices[0]?.message?.content?.trim() || null;

        if (!title) {
            return null;
        }

        // Clean up the title (remove quotes, colons, etc. if AI didn't follow rules)
        let cleanedTitle = title
            .replace(/^["']|["']$/g, "") // Remove surrounding quotes
            .replace(/[:;]/g, "") // Remove colons and semicolons
            .trim();

        // Enforce 60 character limit
        if (cleanedTitle.length > 60) {
            cleanedTitle = `${cleanedTitle.substring(0, 57)}...`;
        }

        return cleanedTitle || null;
    } catch (error) {
        console.error("Error generating title:", error);
        return null;
    }
}
