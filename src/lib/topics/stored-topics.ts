import { decryptJsonField } from "@/lib/encryption/fields";
import { isTopicList } from "./anchor";
import type { TranscriptTopic } from "./timeline";

/** `transcriptions.topics`, decrypted. */
export interface StoredTopics {
    topics: TranscriptTopic[];
    provider: string;
    model: string;
    /** Template the topics were detected with. */
    templateId: string;
    generatedAt: string;
}

/**
 * Decrypt a transcription row's topics.
 *
 * Returns null for a transcript that has none, and for a stored value that
 * does not have the expected shape: a broken list would only render as
 * broken headings, where no topics renders as "Detect topics".
 */
export function readTranscriptTopics(
    row: { topics?: unknown } | null | undefined,
): TranscriptTopic[] | null {
    if (!row || row.topics === null || row.topics === undefined) return null;
    const stored = decryptJsonField<StoredTopics>(row.topics);
    return stored && isTopicList(stored.topics) && stored.topics.length > 0
        ? stored.topics
        : null;
}
