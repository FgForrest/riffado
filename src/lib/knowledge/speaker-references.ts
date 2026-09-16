import type { SpeakerNameResolver } from "@/lib/transcription/turns";

export interface SpeakerAttribution {
    personId: string;
    name: string;
}

export type SpeakerAttributions = Readonly<Record<string, SpeakerAttribution>>;

const SUMMARY_SPEAKER_REFERENCE =
    /\[Speaker ([0-9]+)\]\(#speaker-\1\)|\bSpeaker ([0-9]+)\b/g;

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

/** Find an attribution across equivalent provider label formats. */
export function resolveSpeakerAttribution(
    attributions: SpeakerAttributions | undefined,
    speaker: string,
): SpeakerAttribution | undefined {
    const direct = attributions?.[speaker];
    if (direct) return direct;

    const anchor = speakerAnchorId(speaker);
    return Object.entries(attributions ?? {}).find(
        ([label]) => speakerAnchorId(label) === anchor,
    )?.[1];
}

/** Convert plain model-authored speaker labels into stable summary links. */
export function canonicalizeSummarySpeakerReferences(markdown: string): string {
    return markdown.replace(
        SUMMARY_SPEAKER_REFERENCE,
        (
            reference,
            linkedNumber: string | undefined,
            plainNumber: string | undefined,
        ) => {
            const speakerNumber = linkedNumber ?? plainNumber;
            if (!speakerNumber) return reference;
            return `[Speaker ${speakerNumber}](#speaker-${speakerNumber})`;
        },
    );
}

/**
 * Project stored speaker references into portable text for disk exports.
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
        SUMMARY_SPEAKER_REFERENCE,
        (
            reference,
            linkedNumber: string | undefined,
            plainNumber: string | undefined,
        ) => {
            const speakerNumber = linkedNumber ?? plainNumber;
            if (!speakerNumber) return reference;
            return (
                resolve?.(`speaker_${speakerNumber}`) ??
                resolve?.(`Speaker ${speakerNumber}`) ??
                resolve?.(`speaker-${speakerNumber}`) ??
                `Speaker ${speakerNumber}`
            );
        },
    );
}
