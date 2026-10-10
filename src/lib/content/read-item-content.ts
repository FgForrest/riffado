import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    mailContents,
    mailParticipants,
    transcriptions,
} from "@/db/schema";
import { audioContentFrom } from "@/lib/content/audio-content";
import {
    type MailContentSource,
    mailContentFrom,
} from "@/lib/content/mail-content";
import type { ItemContent } from "@/lib/content/types";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
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
            return readMailContent(ownerUserId, itemId);
    }
}

async function readMailContent(
    ownerUserId: string,
    itemId: string,
): Promise<ItemContent | null> {
    const [[content], participants] = await Promise.all([
        db
            .select({
                id: mailContents.id,
                revision: mailContents.revision,
                language: mailContents.language,
                segments: mailContents.segments,
            })
            .from(mailContents)
            .where(
                and(
                    eq(mailContents.itemId, itemId),
                    eq(mailContents.userId, ownerUserId),
                ),
            )
            .limit(1),
        db
            .select({
                ref: mailParticipants.ref,
                roles: mailParticipants.roles,
                name: mailParticipants.name,
                address: mailParticipants.address,
                authenticated: mailParticipants.authenticated,
                personId: mailParticipants.personId,
            })
            .from(mailParticipants)
            .where(
                and(
                    eq(mailParticipants.itemId, itemId),
                    eq(mailParticipants.userId, ownerUserId),
                ),
            )
            .orderBy(asc(mailParticipants.position)),
    ]);
    if (!content) return null;
    return mailContentFrom({
        itemId,
        contentId: content.id,
        revision: content.revision,
        language: content.language,
        segments:
            decryptJsonField<MailContentSource["segments"]>(content.segments) ??
            [],
        participants: participants.map((participant) => ({
            ref: participant.ref,
            roles: participant.roles,
            name: participant.name ? decryptText(participant.name) : null,
            address: participant.address
                ? decryptText(participant.address)
                : null,
            authenticated: participant.authenticated,
            personId: participant.personId,
        })),
    });
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
