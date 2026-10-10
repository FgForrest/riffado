import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import { chatterItems, knowledgeFactEvidence, recordings } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { readableScopes } from "@/lib/knowledge/scope";
import type { McpCaller } from "@/lib/mcp/caller";
import {
    knowledgeContextFor,
    mcpRecordingCondition,
    recordingViewFor,
} from "@/lib/mcp/scope";
import type { RecordingView } from "@/lib/sharing/view";

/** Words said in a recording that support a fact. */
export interface FactEvidence {
    recordingId: string;
    /** The view the caller opens the recording in. */
    view: RecordingView;
    /** Where in the recording; null for text-anchored evidence. */
    startMs: number | null;
    quote: string;
}

/** Evidence returned per fact, newest recording first. */
export const MAX_EVIDENCE_PER_FACT = 3;

/**
 * The supported evidence of facts the caller reads, by fact id: only in
 * recordings the caller reads (`mcpRecordingCondition`), only of facts in
 * the knowledge scopes it reads, at most three per fact. Quotes are
 * transcript text: call this only for a caller holding `transcripts:read`.
 */
export async function supportedEvidence(
    caller: McpCaller,
    factIds: readonly string[],
): Promise<Map<string, FactEvidence[]>> {
    const byFact = new Map<string, FactEvidence[]>();
    const ids = [...new Set(factIds)];
    if (ids.length === 0) return byFact;
    const scopes = readableScopes(
        knowledgeContextFor(caller),
        caller.orgUserId,
    );
    const rows = await db
        .select({
            factId: knowledgeFactEvidence.factId,
            recordingId: knowledgeFactEvidence.itemId,
            ownerUserId: recordings.userId,
            startMs: knowledgeFactEvidence.startMs,
            quote: knowledgeFactEvidence.quote,
        })
        .from(knowledgeFactEvidence)
        .innerJoin(recordings, eq(recordings.id, knowledgeFactEvidence.itemId))
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                inArray(knowledgeFactEvidence.factId, ids),
                inArray(knowledgeFactEvidence.userId, scopes),
                eq(knowledgeFactEvidence.status, "supported"),
                mcpRecordingCondition(caller),
            ),
        )
        .orderBy(
            desc(chatterItems.occurredAt),
            desc(recordings.id),
            knowledgeFactEvidence.startMs,
        );
    for (const row of rows) {
        const held = byFact.get(row.factId) ?? [];
        if (held.length >= MAX_EVIDENCE_PER_FACT) continue;
        held.push({
            recordingId: row.recordingId,
            view: recordingViewFor(caller, row.ownerUserId),
            startMs: row.startMs,
            quote: decryptText(row.quote),
        });
        byFact.set(row.factId, held);
    }
    return byFact;
}
