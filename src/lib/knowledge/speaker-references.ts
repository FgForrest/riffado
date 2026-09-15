import type { SpeakerNameResolver } from "@/lib/transcription/turns";

export interface SpeakerAttribution {
    personId: string;
    name: string;
}

export type SpeakerAttributions = Readonly<Record<string, SpeakerAttribution>>;

const SUMMARY_SPEAKER_LINK = /\[Speaker ([0-9]+)\]\(#speaker-\1\)/g;

/** Stable fragment id used by summary placeholders and transcript speaker tags. */
export function speakerAnchorId(speaker: string): string {
    const numbered = /^speaker[_ -]([0-9]+)$/i.exec(speaker.trim());
    if (numbered) return `speaker-${numbered[1]}`;
    const slug = speaker
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    return `speaker-${slug || "unknown"}`;
}

/** Resolve an exact summary placeholder href back to its raw transcript label. */
export function speakerLabelFromSummaryHref(
    href: string | undefined,
): string | null {
    const match = /^#speaker-([0-9]+)$/.exec(href ?? "");
    return match ? `speaker_${match[1]}` : null;
}

/**
 * Project stored speaker links into portable text for disk exports.
 *
 * The stored summary remains untouched. Known speakers become their confirmed
 * names; unknown speakers keep their display labels. Neither keeps a link,
 * because an exported document cannot know the instance's public URL.
 */
export function projectSummarySpeakerReferencesForExport(
    markdown: string,
    resolve?: SpeakerNameResolver,
): string {
    return markdown.replace(
        SUMMARY_SPEAKER_LINK,
        (_reference, speakerNumber: string) =>
            resolve?.(`speaker_${speakerNumber}`) ?? `Speaker ${speakerNumber}`,
    );
}
