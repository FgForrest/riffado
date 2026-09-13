import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { people, transcriptSpeakers } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { readTranscriptTurns } from "@/lib/transcription/read-turns";
import {
    renderTurnsAsText,
    type SpeakerNameResolver,
} from "@/lib/transcription/turns";

/** The columns any caller must already have to project a transcript. */
export interface ProjectableTranscript {
    id: string;
    /** Plaintext. Callers decrypt before projecting; this never touches keys. */
    text: string;
    turns?: unknown;
}

/**
 * Apply speaker names to a transcript without rewriting what is stored.
 *
 * Falls back to the plain text whenever there is nothing to apply -- no
 * stored turns, or no confirmed attribution -- so a transcript that predates
 * this feature reads exactly as it always did.
 */
export function projectTranscript(
    transcript: ProjectableTranscript,
    resolve: SpeakerNameResolver | undefined,
): string {
    if (!resolve) return transcript.text;
    const turns = readTranscriptTurns(transcript);
    if (!turns) return transcript.text;
    const projected = renderTurnsAsText(turns, resolve);
    return projected || transcript.text;
}

/**
 * One resolver per transcript, in a single query.
 *
 * The export paths walk every transcript a user owns, so asking per
 * transcript would be an N+1 against a table that already joins to people.
 * Returns an empty map when nothing is confirmed, and callers then project
 * nothing, which is the correct no-op.
 */
export async function buildResolverMap(
    userId: string,
    transcriptionIds: readonly string[],
): Promise<Map<string, SpeakerNameResolver>> {
    if (transcriptionIds.length === 0) return new Map();

    const rows = await db
        .select({
            transcriptionId: transcriptSpeakers.transcriptionId,
            label: transcriptSpeakers.label,
            displayName: people.displayName,
        })
        .from(transcriptSpeakers)
        .innerJoin(people, eq(people.id, transcriptSpeakers.personId))
        .where(
            and(
                eq(transcriptSpeakers.userId, userId),
                eq(transcriptSpeakers.status, "confirmed"),
                inArray(
                    transcriptSpeakers.transcriptionId,
                    transcriptionIds as string[],
                ),
            ),
        );

    return resolverMapFromRows(rows);
}

/** The grouping rule, separated from the query so it can be tested alone. */
export function resolverMapFromRows(
    rows: readonly {
        transcriptionId: string;
        label: string;
        displayName: string;
    }[],
): Map<string, SpeakerNameResolver> {
    const byTranscript = new Map<string, Map<string, string>>();

    for (const row of rows) {
        const names =
            byTranscript.get(row.transcriptionId) ?? new Map<string, string>();
        names.set(row.label, decryptText(row.displayName));
        byTranscript.set(row.transcriptionId, names);
    }

    return new Map(
        [...byTranscript].map(([transcriptionId, names]) => [
            transcriptionId,
            (speaker: string) => names.get(speaker) ?? null,
        ]),
    );
}
