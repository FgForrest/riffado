"use client";

import { useExtracted } from "next-intl";
import type { PromptPreset } from "@/lib/ai/prompt-presets";
import type { SummaryPreset } from "@/lib/ai/summary-presets";

export interface PresetCopy {
    name: string;
    description: string;
}

/** Localized names and descriptions of the built-in summary templates. */
export function useSummaryPresetCopy(): Record<SummaryPreset, PresetCopy> {
    const i18n = useExtracted();
    return {
        general: {
            name: i18n("General Summary"),
            description: i18n("Concise summary of any audio transcription"),
        },
        "meeting-notes": {
            name: i18n("Meeting Notes"),
            description: i18n(
                "Structured meeting summary with attendees, decisions, and action items",
            ),
        },
        "key-points": {
            name: i18n("Key Points"),
            description: i18n("Extract the key points as a bullet list"),
        },
        "action-items": {
            name: i18n("Action Items"),
            description: i18n(
                "Extract all action items, tasks, and follow-ups mentioned",
            ),
        },
    };
}

/** Localized names and descriptions of the built-in title templates. */
export function useTitlePresetCopy(): Record<PromptPreset, PresetCopy> {
    const i18n = useExtracted();
    return {
        // Shown as "General" although the id is `default`: next to the
        // Default badge, a template called "Default" read as "Default
        // [Default]".
        default: {
            name: i18n("General"),
            description: i18n(
                "General purpose title generation for any recording type",
            ),
        },
        meetings: {
            name: i18n("Meetings"),
            description: i18n(
                "Optimized for business meetings, standups, and team discussions",
            ),
        },
        lectures: {
            name: i18n("Lectures"),
            description: i18n(
                "Designed for educational content, courses, and presentations",
            ),
        },
        "phone-calls": {
            name: i18n("Phone Calls"),
            description: i18n(
                "Tailored for phone conversations and interviews",
            ),
        },
        "audio-blog": {
            name: i18n("Casual Audio Blog"),
            description: i18n(
                "Perfect for personal notes, vlogs, and casual recordings",
            ),
        },
        "idea-stormer": {
            name: i18n("Idea Stormer"),
            description: i18n(
                "Optimized for brainstorming sessions and creative thinking",
            ),
        },
    };
}
