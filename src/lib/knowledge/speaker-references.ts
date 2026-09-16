import type { SpeakerNameResolver } from "@/lib/transcription/turns";

export interface SpeakerAttribution {
    personId: string;
    name: string;
}

export type SpeakerAttributions = Readonly<Record<string, SpeakerAttribution>>;

const SUMMARY_SPEAKER_REFERENCE =
    /\[Speaker ([0-9]+)\]\(#speaker-\1\)|\bSpeaker ([0-9]+)\b/g;
const NUMBERED_SPEAKER = /^speaker[_ -]([0-9]+)$/i;

/** Stable fragment id used by summary placeholders and transcript speaker tags. */
export function speakerAnchorId(speaker: string): string {
    const numbered = NUMBERED_SPEAKER.exec(speaker.trim());
    if (numbered) return `speaker-${numbered[1]}`;
    const slug = speaker
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    return `speaker-${slug || "unknown"}`;
}

/**
 * Detect an LLM summary that shifted a zero-based transcript to one-based
 * placeholders (`Speaker 1…N`). The match is deliberately strict: both sides
 * must contain the complete contiguous range, so a summary that merely omits
 * Speaker 0 is not accidentally shifted.
 */
export function inferSummarySpeakerNumberOffset(
    markdown: string,
    transcriptSpeakers: readonly string[],
): number {
    const transcriptNumbers = Array.from(
        new Set(
            transcriptSpeakers.flatMap((speaker) => {
                const match = NUMBERED_SPEAKER.exec(speaker.trim());
                return match ? [Number(match[1])] : [];
            }),
        ),
    ).sort((left, right) => left - right);
    const summaryNumbers = Array.from(
        new Set(
            Array.from(markdown.matchAll(SUMMARY_SPEAKER_REFERENCE)).flatMap(
                (match) => {
                    const value = match[1] ?? match[2];
                    return value === undefined ? [] : [Number(value)];
                },
            ),
        ),
    ).sort((left, right) => left - right);

    const transcriptIsZeroBased =
        transcriptNumbers.length > 0 &&
        transcriptNumbers.every((number, index) => number === index);
    const summaryIsOneBased =
        summaryNumbers.length === transcriptNumbers.length &&
        summaryNumbers.every((number, index) => number === index + 1);
    return transcriptIsZeroBased && summaryIsOneBased ? -1 : 0;
}

/** Apply a previously inferred numeric offset to a raw speaker label. */
export function offsetSpeakerLabel(speaker: string, offset: number): string {
    if (offset === 0) return speaker;
    const match = NUMBERED_SPEAKER.exec(speaker.trim());
    if (!match) return speaker;
    const shifted = Number(match[1]) + offset;
    return shifted >= 0 ? `speaker_${shifted}` : speaker;
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
    speakerNumberOffset = 0,
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
            const speaker = offsetSpeakerLabel(
                `speaker_${speakerNumber}`,
                speakerNumberOffset,
            );
            const projectedNumber = speaker.slice("speaker_".length);
            return (
                resolve?.(speaker) ??
                resolve?.(`Speaker ${projectedNumber}`) ??
                resolve?.(`speaker-${projectedNumber}`) ??
                `Speaker ${projectedNumber}`
            );
        },
    );
}
