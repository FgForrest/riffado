import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
    type ChatterItemKind,
    chatterItems,
    knowledgeFactEvidence,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { readableScopes } from "@/lib/knowledge/scope";
import { secretAddressMasker } from "@/lib/mail/redact";
import type { McpCaller } from "@/lib/mcp/caller";
import {
    knowledgeContextFor,
    mayReadMail,
    mcpItemCondition,
    recordingViewFor,
} from "@/lib/mcp/scope";
import type { RecordingView } from "@/lib/sharing/view";

/** Words said in a recording, or written in a mail, that support a fact. */
export interface FactEvidence {
    /** The recording or mail. */
    recordingId: string;
    kind: ChatterItemKind;
    /** The view the caller opens it in. */
    view: RecordingView;
    /** Where in the recording; null for evidence in a mail. */
    startMs: number | null;
    quote: string;
    /** Written in a quoted part of the mail: an earlier writer's words. */
    quoted: boolean;
}

/** Evidence returned per fact, newest item first. */
export const MAX_EVIDENCE_PER_FACT = 3;

/** The kinds of item whose words the caller may read as evidence. */
export function evidenceKinds(caller: McpCaller): ChatterItemKind[] {
    return [
        ...(caller.roles.has("transcripts:read") ? (["audio"] as const) : []),
        ...(mayReadMail(caller) ? (["mail"] as const) : []),
    ];
}

/**
 * The supported evidence of facts the caller reads, by fact id: only in
 * items the caller reads of the kinds its roles open (recordings with
 * `transcripts:read`, mail with `mail:read`), only of facts in the
 * knowledge scopes it reads, at most three per fact. Secret addresses in
 * a mail's words are masked.
 */
export async function supportedEvidence(
    caller: McpCaller,
    factIds: readonly string[],
): Promise<Map<string, FactEvidence[]>> {
    const byFact = new Map<string, FactEvidence[]>();
    const ids = [...new Set(factIds)];
    const kinds = evidenceKinds(caller);
    if (ids.length === 0 || kinds.length === 0) return byFact;
    const scopes = readableScopes(
        knowledgeContextFor(caller),
        caller.orgUserId,
    );
    const rows = await db
        .select({
            factId: knowledgeFactEvidence.factId,
            recordingId: knowledgeFactEvidence.itemId,
            ownerUserId: chatterItems.userId,
            kind: chatterItems.kind,
            startMs: knowledgeFactEvidence.startMs,
            quote: knowledgeFactEvidence.quote,
            provenance: knowledgeFactEvidence.provenance,
        })
        .from(knowledgeFactEvidence)
        .innerJoin(
            chatterItems,
            eq(chatterItems.id, knowledgeFactEvidence.itemId),
        )
        .where(
            and(
                inArray(knowledgeFactEvidence.factId, ids),
                inArray(knowledgeFactEvidence.userId, scopes),
                eq(knowledgeFactEvidence.status, "supported"),
                mcpItemCondition(caller, kinds),
            ),
        )
        .orderBy(
            desc(chatterItems.occurredAt),
            desc(chatterItems.id),
            knowledgeFactEvidence.startMs,
        );
    const quotes = rows.map((row) => ({
        ...row,
        text: decryptText(row.quote),
    }));
    const mailQuotes = quotes
        .filter((row) => row.kind === "mail")
        .map((row) => row.text);
    const mask =
        mailQuotes.length > 0
            ? await secretAddressMasker(mailQuotes)
            : (text: string) => text;
    for (const row of quotes) {
        const held = byFact.get(row.factId) ?? [];
        if (held.length >= MAX_EVIDENCE_PER_FACT) continue;
        held.push({
            recordingId: row.recordingId,
            kind: row.kind,
            view: recordingViewFor(caller, row.ownerUserId),
            startMs: row.startMs,
            quote: row.kind === "mail" ? mask(row.text) : row.text,
            quoted: row.provenance === "quoted",
        });
        byFact.set(row.factId, held);
    }
    return byFact;
}
