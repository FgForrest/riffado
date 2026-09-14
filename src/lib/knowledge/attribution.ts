import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { people, transcriptSpeakers } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import type { SpeakerNameResolver } from "@/lib/transcription/turns";

export type AttributionSource =
    | "user"
    | "calendar"
    | "meet"
    | "llm"
    | "heuristic";

export type AttributionStatus = "confirmed" | "suggested" | "rejected";

/** One speaker label of one transcript, and who it refers to. */
export interface TranscriptSpeaker {
    id: string;
    label: string;
    personId: string | null;
    personName: string | null;
    source: AttributionSource;
    status: AttributionStatus;
    confidence: number | null;
    evidenceStartMs: number | null;
}

export interface SetTranscriptSpeakerArgs {
    userId: string;
    transcriptionId: string;
    label: string;
    personId: string | null;
    source: AttributionSource;
    status: AttributionStatus;
    confidence?: number | null;
    evidenceStartMs?: number | null;
}

/**
 * Every attribution for one transcript, resolved names included.
 *
 * `ownerId` is the user the transcript belongs to, not necessarily the user
 * asking: a speaker is named by the owner, so a reader of a shared transcript
 * must see the owner's naming rather than their own. It also bounds the join
 * to `people`, so a stored `personId` can never reach across a tenant.
 */
export async function getTranscriptSpeakers(
    ownerId: string,
    transcriptionId: string,
): Promise<TranscriptSpeaker[]> {
    const rows = await db
        .select({
            id: transcriptSpeakers.id,
            label: transcriptSpeakers.label,
            personId: transcriptSpeakers.personId,
            personName: people.displayName,
            source: transcriptSpeakers.source,
            status: transcriptSpeakers.status,
            confidence: transcriptSpeakers.confidence,
            evidenceStartMs: transcriptSpeakers.evidenceStartMs,
        })
        .from(transcriptSpeakers)
        .leftJoin(
            people,
            and(
                eq(people.id, transcriptSpeakers.personId),
                eq(people.userId, ownerId),
            ),
        )
        .where(
            and(
                eq(transcriptSpeakers.userId, ownerId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
            ),
        );

    return rows.map((row) => ({
        ...row,
        personName: row.personName ? decryptText(row.personName) : null,
    }));
}

/**
 * Record who a speaker label refers to, replacing any previous answer for
 * that label.
 *
 * A correction is an ordinary update with nothing downstream to repair,
 * which is the whole benefit of attributing by name rather than by
 * voiceprint: there is no profile to poison, only a label to change.
 */
export async function setTranscriptSpeaker({
    userId,
    transcriptionId,
    label,
    personId,
    source,
    status,
    confidence = null,
    evidenceStartMs = null,
}: SetTranscriptSpeakerArgs): Promise<void> {
    await db
        .insert(transcriptSpeakers)
        .values({
            userId,
            transcriptionId,
            label,
            personId,
            source,
            status,
            confidence,
            evidenceStartMs,
        })
        .onConflictDoUpdate({
            target: [
                transcriptSpeakers.transcriptionId,
                transcriptSpeakers.label,
            ],
            set: {
                personId,
                source,
                status,
                confidence,
                evidenceStartMs,
                updatedAt: new Date(),
            },
        });
}

/**
 * Build the function that turns a raw speaker label into a display name.
 *
 * **Confirmed attributions only.** A suggested attribution renders in the UI
 * as a suggestion and never reaches transcript text, a summary prompt, an
 * export or the API: a machine guess that silently became the name on a
 * meeting minute is the failure this feature most needs to avoid, and
 * refusing to project it is what prevents that.
 *
 * Returns `undefined` when nobody is named, so `projectTranscript` serves the
 * stored text verbatim rather than re-rendering it from the turns for no gain.
 *
 * `ownerId` is the user the transcript belongs to, not necessarily the user
 * asking: a speaker is named by the owner, so a reader of a shared transcript
 * must see the owner's naming rather than their own. It also bounds the join
 * to `people`, so a stored `personId` can never reach across a tenant.
 */
export async function buildNameResolver(
    ownerId: string,
    transcriptionId: string,
): Promise<SpeakerNameResolver | undefined> {
    const rows = await db
        .select({
            label: transcriptSpeakers.label,
            displayName: people.displayName,
        })
        .from(transcriptSpeakers)
        .innerJoin(
            people,
            and(
                eq(people.id, transcriptSpeakers.personId),
                eq(people.userId, ownerId),
            ),
        )
        .where(
            and(
                eq(transcriptSpeakers.userId, ownerId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
                eq(transcriptSpeakers.status, "confirmed"),
            ),
        );

    return rows.length > 0 ? namesFromRows(rows) : undefined;
}

/**
 * The resolver itself, separated from the query so the projection rule is
 * testable without a database.
 */
export function namesFromRows(
    rows: readonly { label: string; displayName: string }[],
): SpeakerNameResolver {
    const names = new Map(
        rows.map((row) => [row.label, decryptText(row.displayName)]),
    );
    return (speaker: string) => names.get(speaker) ?? null;
}

/** A resolver that names nobody, for transcripts with no attributions. */
export function emptyNameResolver(): SpeakerNameResolver {
    return () => null;
}
