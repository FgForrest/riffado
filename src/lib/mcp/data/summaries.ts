import { and, asc, eq, exists, inArray, type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiEnhancements, recordings, transcriptions } from "@/db/schema";
import type { McpCaller } from "@/lib/mcp/caller";
import type { FilteredRecording } from "@/lib/mcp/data/recordings";
import { mcpRecordingCondition } from "@/lib/mcp/scope";
import { getPreferredTranscriptSource } from "@/lib/v1/serialize";

/** A recording's stored summary row (still encrypted) and its language. */
export interface SummaryForSearch {
    enhancement: typeof aiEnhancements.$inferSelect;
    /** The detected language of the recording's primary transcript. */
    language: string | null;
}

/** SQL over `recordings`: the recording has a summary (its owner's). */
export function hasSummaryCondition(): SQL {
    return exists(
        db
            .select({ one: sql`1` })
            .from(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.itemId, recordings.id),
                    eq(aiEnhancements.userId, recordings.userId),
                ),
            ),
    );
}

/**
 * The summary of each recording in `rows` the caller reads, by recording
 * id: the owner's Riffado summary, else the Plaud one (as
 * `readStoredSummary`), with the language of the primary transcript (the
 * caller's preferred source, else Riffado's, else the first).
 */
export async function summariesForSearch(
    caller: McpCaller,
    rows: readonly Pick<FilteredRecording, "id">[],
): Promise<Map<string, SummaryForSearch>> {
    const found = new Map<string, SummaryForSearch>();
    if (rows.length === 0) return found;
    const ids = rows.map((row) => row.id);
    const visible = mcpRecordingCondition(caller);
    const [enhancements, transcripts, preferred] = await Promise.all([
        db
            .select({ enhancement: aiEnhancements })
            .from(aiEnhancements)
            .innerJoin(
                recordings,
                and(
                    eq(recordings.id, aiEnhancements.itemId),
                    eq(recordings.userId, aiEnhancements.userId),
                ),
            )
            .where(and(inArray(aiEnhancements.itemId, ids), visible)),
        db
            .select({
                recordingId: transcriptions.recordingId,
                source: transcriptions.source,
                language: transcriptions.detectedLanguage,
            })
            .from(transcriptions)
            .innerJoin(
                recordings,
                and(
                    eq(recordings.id, transcriptions.recordingId),
                    eq(recordings.userId, transcriptions.userId),
                ),
            )
            .where(and(inArray(transcriptions.recordingId, ids), visible))
            .orderBy(asc(transcriptions.createdAt), asc(transcriptions.id)),
        getPreferredTranscriptSource(
            caller.kind === "user" ? caller.userId : caller.orgUserId,
        ),
    ]);

    const languages = new Map<string, string | null>();
    const byRecording = new Map<string, typeof transcripts>();
    for (const transcript of transcripts) {
        const held = byRecording.get(transcript.recordingId) ?? [];
        held.push(transcript);
        byRecording.set(transcript.recordingId, held);
    }
    for (const [recordingId, held] of byRecording) {
        const primary =
            held.find((t) => t.source === preferred) ??
            held.find((t) => t.source === "riffado") ??
            held[0];
        languages.set(recordingId, primary?.language ?? null);
    }

    for (const { enhancement } of enhancements) {
        const held = found.get(enhancement.itemId);
        if (held && held.enhancement.source === "riffado") continue;
        found.set(enhancement.itemId, {
            enhancement,
            language: languages.get(enhancement.itemId) ?? null,
        });
    }
    return found;
}
