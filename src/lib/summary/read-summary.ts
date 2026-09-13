/**
 * Read a stored summary back out in the shape clients render.
 *
 * Extracted because two places now need it. The GET handler always did, and
 * the streaming POST does too: generation happens on a worker, so the route
 * learns only that the job finished and has to fetch what it produced. Having
 * one function means the summary a client receives from a completed job is
 * byte-for-byte what it would get by reloading the page.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiEnhancements } from "@/db/schema";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import type { MultiPassProvenance } from "./multi-pass";

export interface StoredSummary {
    /** Null for a row that exists but carries no summary text. */
    summary: string | null;
    keyPoints: string[];
    actionItems: string[];
    provider: string | null;
    model: string | null;
    multiPass?: MultiPassProvenance;
    createdAt: Date;
}

export async function readStoredSummary(
    userId: string,
    recordingId: string,
): Promise<StoredSummary | null> {
    const [enhancement] = await db
        .select()
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.recordingId, recordingId),
                eq(aiEnhancements.userId, userId),
            ),
        )
        .limit(1);

    if (!enhancement) return null;

    return {
        // Legacy plaintext rows pass through verbatim during the backfill
        // window; `decryptText` is a no-op on them.
        summary: decryptText(enhancement.summary) ?? null,
        keyPoints: decryptJsonField<string[]>(enhancement.keyPoints) ?? [],
        actionItems: decryptJsonField<string[]>(enhancement.actionItems) ?? [],
        provider: enhancement.provider,
        model: enhancement.model,
        // Nested, matching what POST returns, so a client has one shape to
        // render rather than flat columns here and an object there. NULL
        // rounds means the summary predates multi-pass or was single-pass.
        multiPass:
            enhancement.multiPassRounds == null
                ? undefined
                : {
                      roundsRequested: enhancement.multiPassRounds,
                      passesUsed: enhancement.multiPassUsed ?? 0,
                      merged: enhancement.multiPassMerged ?? false,
                  },
        createdAt: enhancement.createdAt,
    };
}
