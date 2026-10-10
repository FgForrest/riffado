import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import {
    chatterItems,
    recordings,
    recordingTasks,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import {
    findByName,
    type KnowledgeView,
    knowledgeView,
} from "@/lib/knowledge/knowledge-loader";
import { normalizeName } from "@/lib/knowledge/name-match";
import type { McpCaller } from "@/lib/mcp/caller";
import { McpToolError } from "@/lib/mcp/errors";
import { allowMcpScan } from "@/lib/mcp/rate-limit";
import {
    knowledgeContextFor,
    mcpRecordingCondition,
    recordingViewFor,
    taskViewerFor,
} from "@/lib/mcp/scope";
import { matchText, prepareQuery } from "@/lib/mcp/text-search";
import type { RecordingView } from "@/lib/sharing/view";
import { taskListed } from "@/lib/tasks/access";

/** One thing a name may mean, scored as name matching scores it. */
export interface Candidate {
    id: string;
    name: string;
    typeKey: string;
    score: number;
    /** The name, an alias or a heard-as form equals the input. */
    exact: boolean;
}

/** What a name means: one candidate, none, or too many to choose from. */
export type Decision =
    | { kind: "match"; candidate: Candidate }
    | { kind: "none" }
    | { kind: "ambiguous"; candidates: Candidate[] };

const CLEAR_SCORE = 0.9;
const CLEAR_LEAD = 0.15;
const MAX_CANDIDATES = 5;
const TITLE_SCAN = 500;
const MAX_INPUT = 200;
const MATCHES_CHECKED = 50;

/**
 * Pick the candidate a name means: the only exact one, else a top
 * candidate scoring at least 0.9 and 0.15 ahead of the next. Several
 * exact candidates, or no clear lead, is ambiguous (the best five).
 */
export function decideMatch(candidates: readonly Candidate[]): Decision {
    if (candidates.length === 0) return { kind: "none" };
    const ranked = [...candidates].sort((a, b) => b.score - a.score);
    const exact = ranked.filter((candidate) => candidate.exact);
    if (exact.length === 1 && exact[0]) {
        return { kind: "match", candidate: exact[0] };
    }
    const [top, second] = ranked;
    if (
        exact.length === 0 &&
        top &&
        top.score >= CLEAR_SCORE &&
        (!second || top.score - second.score >= CLEAR_LEAD)
    ) {
        return { kind: "match", candidate: top };
    }
    const first = exact.length > 1 ? exact : ranked;
    return { kind: "ambiguous", candidates: first.slice(0, MAX_CANDIDATES) };
}

/** A person or entity a reference resolved to. */
export interface Resolved {
    id: string;
    name: string;
    kind: "person" | "entity";
    typeKey: string;
    /** `id`, or the name-match reason (`exact`, `token`, `edit`, …). */
    matchedBy: string;
}

/** A recording a reference resolved to. */
export interface ResolvedRecording {
    id: string;
    ownerUserId: string;
    title: string;
    /** When it was recorded, ISO 8601. */
    recordedAt: string;
    view: RecordingView;
    /** `id`, `exact` (the whole title) or `words` (all its words). */
    matchedBy: string;
}

/** The `resolved` echo of a tool's output. */
export const resolvedSchema = z.object({
    input: z.string(),
    id: z.string(),
    name: z.string(),
    matched_by: z.string(),
});

/** The `resolved` echo for a reference given as text (not for an id). */
export function echoResolved(
    input: string,
    resolved: { id: string; matchedBy: string } & (
        | { name: string }
        | { title: string }
    ),
): z.infer<typeof resolvedSchema> | undefined {
    if (resolved.matchedBy === "id") return undefined;
    return {
        input,
        id: resolved.id,
        name: "name" in resolved ? resolved.name : resolved.title,
        matched_by: resolved.matchedBy,
    };
}

function cleanInput(input: string): string {
    const clean = input.trim();
    if (!clean || clean.length > MAX_INPUT) {
        throw new McpToolError("Give a name or an id");
    }
    return clean;
}

function noMatch(input: string): McpToolError {
    return new McpToolError(`No match for "${input}"`, "not_found");
}

function ambiguous(candidates: readonly Candidate[]): McpToolError {
    return new McpToolError("Ambiguous name", "invalid", {
        candidates: candidates.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            type: candidate.typeKey,
        })),
    });
}

const RECORDING_ROLES = [
    "transcripts:read",
    "summaries:read",
    "tasks:read",
] as const;

/**
 * Of `personIds`, those a caller without `knowledge:read` may name: people
 * confirmed as speakers in recordings it reads, and (with `tasks:read`)
 * assignees of tasks it sees.
 */
async function namablePeople(
    caller: McpCaller,
    personIds: readonly string[],
): Promise<Set<string>> {
    const ids = [...new Set(personIds)];
    const allowed = new Set<string>();
    if (ids.length === 0) return allowed;
    if (RECORDING_ROLES.some((role) => caller.roles.has(role))) {
        const speakers = await db
            .selectDistinct({ personId: transcriptSpeakers.personId })
            .from(transcriptSpeakers)
            .innerJoin(
                transcriptions,
                and(
                    eq(transcriptions.id, transcriptSpeakers.transcriptionId),
                    eq(transcriptions.userId, transcriptSpeakers.userId),
                ),
            )
            .innerJoin(
                recordings,
                and(
                    eq(recordings.id, transcriptions.recordingId),
                    eq(recordings.userId, transcriptions.userId),
                ),
            )
            .where(
                and(
                    inArray(transcriptSpeakers.personId, ids),
                    eq(transcriptSpeakers.status, "confirmed"),
                    mcpRecordingCondition(caller),
                ),
            );
        for (const row of speakers) {
            if (row.personId) allowed.add(row.personId);
        }
    }
    if (caller.roles.has("tasks:read")) {
        const viewer = await taskViewerFor(caller);
        const assignees = await db
            .selectDistinct({ personId: recordingTasks.assigneePersonId })
            .from(recordingTasks)
            .innerJoin(recordings, eq(recordings.id, recordingTasks.itemId))
            .where(
                and(
                    isNotNull(recordingTasks.assigneePersonId),
                    inArray(recordingTasks.assigneePersonId, ids),
                    ne(recordingTasks.status, "proposed"),
                    mcpRecordingCondition(caller),
                    taskListed(viewer),
                ),
            );
        for (const row of assignees) {
            if (row.personId) allowed.add(row.personId);
        }
    }
    return allowed;
}

type ViewItem = KnowledgeView["items"][number];

/**
 * A person or entity named by id or by words (names, aliases, heard-as
 * forms), as this caller may see it. Without `knowledge:read` only people
 * the caller already meets resolve (speakers of its recordings, assignees
 * of its tasks), never entities. Throws `McpToolError`: not found, or
 * ambiguous with up to five visible candidates.
 */
export async function resolveTarget(
    caller: McpCaller,
    input: string,
    kinds: readonly ("person" | "entity")[],
): Promise<Resolved> {
    const text = cleanInput(input);
    const fullKnowledge = caller.roles.has("knowledge:read");
    const wanted = new Set(
        fullKnowledge ? kinds : kinds.filter((kind) => kind === "person"),
    );
    if (wanted.size === 0) throw noMatch(text);

    const view = await knowledgeView(knowledgeContextFor(caller));
    const items = new Map<string, ViewItem>();
    for (const item of view.items) {
        if (wanted.has(item.kind)) items.set(item.id, item);
    }
    const byId = items.get(text);
    const matches = findByName(view, text, null)
        .filter((match) => items.has(match.id))
        .slice(0, MATCHES_CHECKED);

    let namable: (id: string) => boolean = () => true;
    if (!fullKnowledge) {
        const allowed = await namablePeople(caller, [
            ...(byId ? [byId.id] : []),
            ...matches.map((match) => match.id),
        ]);
        namable = (id) => allowed.has(id);
    }

    const resolved = (item: ViewItem, matchedBy: string): Resolved => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        typeKey: item.typeKey,
        matchedBy,
    });
    if (byId && namable(byId.id)) return resolved(byId, "id");

    const candidates: Candidate[] = [];
    const reasons = new Map<string, string>();
    for (const match of matches) {
        const item = items.get(match.id);
        if (!item || !namable(item.id)) continue;
        reasons.set(item.id, match.reason);
        candidates.push({
            id: item.id,
            name: item.name,
            typeKey: item.typeKey,
            score: match.score,
            exact: match.reason === "exact",
        });
    }
    const decision = decideMatch(candidates);
    if (decision.kind === "none") throw noMatch(text);
    if (decision.kind === "ambiguous") throw ambiguous(decision.candidates);
    const item = items.get(decision.candidate.id);
    if (!item) throw noMatch(text);
    return resolved(item, reasons.get(item.id) ?? "name");
}

/**
 * A recording named by id or by title, among those this caller reads.
 * Titles are encrypted, so a title is looked for among the newest 500
 * readable recordings: the whole title (case and accents aside), else all
 * of its words; that scan counts against the caller's search budget.
 * Throws `McpToolError`: not found, ambiguous with up to five candidates,
 * or denied over the budget.
 */
export async function resolveRecording(
    caller: McpCaller,
    input: string,
): Promise<ResolvedRecording> {
    const text = cleanInput(input);
    const visible = mcpRecordingCondition(caller);
    const columns = {
        id: recordings.id,
        userId: recordings.userId,
        filename: chatterItems.title,
        startTime: chatterItems.occurredAt,
    };
    type Row = {
        id: string;
        userId: string;
        filename: string;
        startTime: Date;
    };
    const resolved = (row: Row, title: string, matchedBy: string) => ({
        id: row.id,
        ownerUserId: row.userId,
        title,
        recordedAt: row.startTime.toISOString(),
        view: recordingViewFor(caller, row.userId),
        matchedBy,
    });

    const [byId] = await db
        .select(columns)
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(and(eq(recordings.id, text), visible))
        .limit(1);
    if (byId) return resolved(byId, decryptText(byId.filename), "id");
    if (!(await allowMcpScan(caller))) {
        throw new McpToolError(
            "Too many searches; retry in a minute",
            "denied",
        );
    }

    const rows = await db
        .select(columns)
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(visible)
        .orderBy(desc(chatterItems.occurredAt), desc(recordings.id))
        .limit(TITLE_SCAN);
    const wanted = normalizeName(text);
    const words = prepareQuery(text, null);
    const titles = new Map<string, { row: Row; title: string }>();
    const candidates: Candidate[] = [];
    for (const row of rows) {
        let title: string;
        try {
            title = decryptText(row.filename);
        } catch {
            continue;
        }
        const exact = wanted !== "" && normalizeName(title) === wanted;
        if (!exact && !matchText(title, words, null)) continue;
        titles.set(row.id, { row, title });
        candidates.push({
            id: row.id,
            name: title,
            typeKey: "recording",
            score: exact ? 1 : CLEAR_SCORE,
            exact,
        });
    }
    const decision = decideMatch(candidates);
    if (decision.kind === "none") throw noMatch(text);
    if (decision.kind === "ambiguous") throw ambiguous(decision.candidates);
    const found = titles.get(decision.candidate.id);
    if (!found) throw noMatch(text);
    return resolved(
        found.row,
        found.title,
        decision.candidate.exact ? "exact" : "words",
    );
}
