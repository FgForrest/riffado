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

/** Every attribution for one transcript, resolved names included. */
export async function getTranscriptSpeakers(
    userId: string,
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
        .leftJoin(people, eq(people.id, transcriptSpeakers.personId))
        .where(
            and(
                eq(transcriptSpeakers.userId, userId),
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
 */
export async function buildNameResolver(
    userId: string,
    transcriptionId: string,
): Promise<SpeakerNameResolver> {
    const rows = await db
        .select({
            label: transcriptSpeakers.label,
            displayName: people.displayName,
        })
        .from(transcriptSpeakers)
        .innerJoin(people, eq(people.id, transcriptSpeakers.personId))
        .where(
            and(
                eq(transcriptSpeakers.userId, userId),
                eq(transcriptSpeakers.transcriptionId, transcriptionId),
                eq(transcriptSpeakers.status, "confirmed"),
            ),
        );

    return namesFromRows(rows);
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
