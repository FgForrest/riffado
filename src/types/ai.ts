import type { TemplateConfiguration } from "@/lib/ai/prompt-templates";

export type PromptPreset =
    | "default"
    | "meetings"
    | "lectures"
    | "phone-calls"
    | "audio-blog"
    | "idea-stormer";

export interface PromptConfig {
    id: PromptPreset;
    name: string;
    description: string;
    prompt: string;
}

/** Title templates are the shared prompt-template model. */
export type PromptConfiguration = TemplateConfiguration;
