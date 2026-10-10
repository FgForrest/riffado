import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems, transcriptions } from "@/db/schema";
import { audioContentFrom } from "@/lib/content/audio-content";
import type { ItemContent } from "@/lib/content/types";
import {
    getPreferredTranscriptSource,
    resolvePrimaryTranscript,
} from "@/lib/v1/serialize";

export interface ReadItemContentOptions {
    /** A recording's transcript to read; its primary one by default. */
    transcriptionId?: string;
}

/**
 * The content of the owner's live item `itemId`, whatever its kind, or null
 * when there is none (no such item, or nothing transcribed yet).
 */
export async function readItemContent(
    ownerUserId: string,
    itemId: string,
    options: ReadItemContentOptions = {},
): Promise<ItemContent | null> {
    const [item] = await db
        .select({ kind: chatterItems.kind })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, ownerUserId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item) return null;
    switch (item.kind) {
        case "audio":
            return readAudioContent(ownerUserId, itemId, options);
        case "mail":
            return null;
    }
}

async function readAudioContent(
    ownerUserId: string,
    recordingId: string,
    options: ReadItemContentOptions,
): Promise<ItemContent | null> {
    const rows = await db
        .select({
            id: transcriptions.id,
            recordingId: transcriptions.recordingId,
            text: transcriptions.text,
            turns: transcriptions.turns,
            revision: transcriptions.revision,
            detectedLanguage: transcriptions.detectedLanguage,
            source: transcriptions.source,
        })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, ownerUserId),
                options.transcriptionId
                    ? eq(transcriptions.id, options.transcriptionId)
                    : undefined,
            ),
        );
    const source = options.transcriptionId
        ? rows[0]
        : resolvePrimaryTranscript(
              rows,
              await getPreferredTranscriptSource(ownerUserId),
          );
    return source ? audioContentFrom(source) : null;
}
