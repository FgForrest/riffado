import {
    and,
    asc,
    eq,
    exists,
    gte,
    inArray,
    isNotNull,
    lt,
    lte,
    not,
    or,
    type SQL,
    sql,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { recordingItemJoin } from "@/db/items";
import {
    chatterItems,
    knowledgeFactEvidence,
    knowledgeFacts,
    recordings,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { type Keyset, keysetBefore, keysetOrder } from "@/lib/db/keyset";
import { env } from "@/lib/env";
import { folderRecordingCondition } from "@/lib/folders/condition";
import { listFolderOrganization } from "@/lib/folders/folders";
import { organizationForDeployment } from "@/lib/folders/hierarchy";
import { orgOwnedCondition } from "@/lib/knowledge/org-people";
import {
    buildOrgResolverMap,
    buildResolverMap,
} from "@/lib/knowledge/project-transcript";
import { readableScopes } from "@/lib/knowledge/scope";
import type { McpCaller } from "@/lib/mcp/caller";
import { encodeKeyset, parseKeyset } from "@/lib/mcp/cursor";
import { McpToolError } from "@/lib/mcp/errors";
import {
    echoResolved,
    type resolvedSchema,
    resolveTarget,
} from "@/lib/mcp/resolve";
import {
    knowledgeContextFor,
    mcpRecordingCondition,
    recordingViewFor,
} from "@/lib/mcp/scope";
import { sharedRecordingCondition } from "@/lib/sharing/shared";
import type { SpeakerNameResolver } from "@/lib/transcription/turns";
import { getPreferredTranscriptSource } from "@/lib/v1/serialize";
import type { FolderOrganization } from "@/types/folder";

/** Recordings per batch of {@link recordingScanSource}. */
export const RECORDING_BATCH = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The recording filters `list_recordings` and the search tools share.
 * `entity` belongs in a caller's schema only with `knowledge:read`
 * ({@link hiddenRecordingFilters}).
 */
export const recordingFilterInput = {
    from: z
        .string()
        .max(40)
        .optional()
        .describe(
            "Recorded at or after this ISO 8601 date or date-time (UTC unless it names a zone).",
        ),
    to: z
        .string()
        .max(40)
        .optional()
        .describe(
            "Recorded at or before this ISO 8601 date-time; a date alone includes that whole day (UTC).",
        ),
    folder: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
            "A folder id from list_folders; recordings in its subfolders count too.",
        ),
    person: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Someone confirmed as a speaker: a person id or name."),
    entity: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
            "Something the recording mentions (a correction or a fact's evidence points at it): an entity id or name.",
        ),
};

/** The filter arguments a call passed. */
export type RecordingFilterArgs = {
    [K in keyof typeof recordingFilterInput]?: string;
};

/** The filters of {@link recordingFilterInput} a caller may not pass. */
export function hiddenRecordingFilters(caller: McpCaller): "entity"[] {
    return caller.roles.has("knowledge:read") ? [] : ["entity"];
}

/** Filters over the recordings a caller reads, references resolved. */
export interface RecordingFilters {
    from: Date | null;
    to: { at: Date; inclusive: boolean } | null;
    folderId: string | null;
    personId: string | null;
    entityId: string | null;
}

/** A reference resolved from text, as a tool echoes it. */
export type ResolvedEcho = z.infer<typeof resolvedSchema>;

function invalidDate(name: string): McpToolError {
    return new McpToolError(
        `${name} must be an ISO 8601 date (YYYY-MM-DD) or date-time`,
    );
}

function parseDay(text: string, name: string): Date {
    const day = new Date(`${text}T00:00:00Z`);
    if (
        Number.isNaN(day.getTime()) ||
        day.toISOString().slice(0, 10) !== text
    ) {
        throw invalidDate(name);
    }
    return day;
}

function parseInstant(text: string, name: string): Date {
    const at = new Date(ZONE.test(text) ? text : `${text}Z`);
    if (Number.isNaN(at.getTime())) throw invalidDate(name);
    return at;
}

function parseFrom(value: string | undefined): Date | null {
    if (value === undefined) return null;
    const text = value.trim();
    if (ISO_DATE.test(text)) return parseDay(text, "from");
    if (ISO_DATE_TIME.test(text)) return parseInstant(text, "from");
    throw invalidDate("from");
}

function parseTo(value: string | undefined): RecordingFilters["to"] {
    if (value === undefined) return null;
    const text = value.trim();
    if (ISO_DATE.test(text)) {
        const day = parseDay(text, "to");
        return { at: new Date(day.getTime() + DAY_MS), inclusive: false };
    }
    if (ISO_DATE_TIME.test(text)) {
        return { at: parseInstant(text, "to"), inclusive: true };
    }
    throw invalidDate("to");
}

/**
 * The filters a call names: dates validated, `person` and `entity`
 * resolved among what the caller may see (`resolveTarget`), each one given
 * as text echoed. `entity` is ignored without `knowledge:read`. Throws
 * `McpToolError` for a bad date, a range that ends before it starts, or a
 * reference that does not resolve.
 */
export async function resolveRecordingFilters(
    caller: McpCaller,
    args: RecordingFilterArgs,
): Promise<{ filters: RecordingFilters; resolved: ResolvedEcho[] }> {
    const from = parseFrom(args.from);
    const to = parseTo(args.to);
    if (from && to && (to.inclusive ? to.at < from : to.at <= from)) {
        throw new McpToolError("from must not be after to");
    }
    const resolved: ResolvedEcho[] = [];
    let personId: string | null = null;
    if (args.person !== undefined) {
        const person = await resolveTarget(caller, args.person, ["person"]);
        personId = person.id;
        const echo = echoResolved(args.person, person);
        if (echo) resolved.push(echo);
    }
    let entityId: string | null = null;
    if (args.entity !== undefined && caller.roles.has("knowledge:read")) {
        const entity = await resolveTarget(caller, args.entity, ["entity"]);
        entityId = entity.id;
        const echo = echoResolved(args.entity, entity);
        if (echo) resolved.push(echo);
    }
    return {
        filters: {
            from,
            to,
            folderId: args.folder ?? null,
            personId,
            entityId,
        },
        resolved,
    };
}

/**
 * The folder tree a caller sees, as the dashboard shows it on this
 * deployment: a user their Private tree and the Organization's, a service
 * caller the Organization's alone.
 */
export async function callerFolderOrganization(
    caller: McpCaller,
): Promise<FolderOrganization> {
    const organization = await listFolderOrganization(treeUserId(caller));
    return organizationForDeployment(organization, {
        isHosted: env.IS_HOSTED,
        selfHostMode: env.SELF_HOST_MODE,
    });
}

function treeUserId(caller: McpCaller): string {
    return caller.kind === "user" ? caller.userId : caller.orgUserId;
}

function sharedCondition(caller: McpCaller): SQL {
    return caller.orgUserId
        ? sharedRecordingCondition(caller.orgUserId)
        : sql`false`;
}

/** The recording's own transcripts (its owner's). */
function ownTranscript(): SQL {
    return and(
        eq(transcriptions.recordingId, recordings.id),
        eq(transcriptions.userId, recordings.userId),
    ) as SQL;
}

function spokeIn(personId: string): SQL {
    return exists(
        db
            .select({ one: sql`1` })
            .from(transcriptSpeakers)
            .innerJoin(
                transcriptions,
                and(
                    eq(transcriptions.id, transcriptSpeakers.transcriptionId),
                    eq(transcriptions.userId, transcriptSpeakers.userId),
                ),
            )
            .where(
                and(
                    ownTranscript(),
                    eq(transcriptSpeakers.personId, personId),
                    eq(transcriptSpeakers.status, "confirmed"),
                ),
            ),
    );
}

function mentions(caller: McpCaller, entityId: string): SQL {
    const shared = sharedCondition(caller);
    const corrected = exists(
        db
            .select({ one: sql`1` })
            .from(transcriptCorrections)
            .innerJoin(
                transcriptions,
                eq(transcriptions.id, transcriptCorrections.transcriptionId),
            )
            .where(
                and(
                    ownTranscript(),
                    eq(transcriptCorrections.targetEntityId, entityId),
                    or(
                        and(
                            shared,
                            orgOwnedCondition(transcriptCorrections.userId),
                        ),
                        and(
                            not(shared),
                            eq(transcriptCorrections.userId, recordings.userId),
                        ),
                    ),
                ),
            ),
    );
    const evidenced = exists(
        db
            .select({ one: sql`1` })
            .from(knowledgeFactEvidence)
            .innerJoin(
                knowledgeFacts,
                eq(knowledgeFacts.id, knowledgeFactEvidence.factId),
            )
            .where(
                and(
                    eq(knowledgeFactEvidence.itemId, recordings.id),
                    eq(knowledgeFactEvidence.status, "supported"),
                    inArray(
                        knowledgeFacts.userId,
                        readableScopes(
                            knowledgeContextFor(caller),
                            caller.orgUserId,
                        ),
                    ),
                    or(
                        eq(knowledgeFacts.subjectEntityId, entityId),
                        eq(knowledgeFacts.objectEntityId, entityId),
                    ),
                ),
            ),
    );
    return or(corrected, evidenced) as SQL;
}

/**
 * SQL over `recordings`: the recordings this caller reads
 * (`mcpRecordingCondition`) that pass `filters`. Throws
 * `McpToolError("No such folder", "not_found")` for a folder outside the
 * caller's tree.
 */
export async function recordingFilterConditions(
    caller: McpCaller,
    filters: RecordingFilters,
): Promise<SQL> {
    const conditions: (SQL | undefined)[] = [mcpRecordingCondition(caller)];
    if (filters.from) {
        conditions.push(gte(chatterItems.occurredAt, filters.from));
    }
    if (filters.to) {
        conditions.push(
            filters.to.inclusive
                ? lte(chatterItems.occurredAt, filters.to.at)
                : lt(chatterItems.occurredAt, filters.to.at),
        );
    }
    if (filters.folderId) {
        const folder = folderRecordingCondition(
            await callerFolderOrganization(caller),
            treeUserId(caller),
            filters.folderId,
        );
        if (!folder) throw new McpToolError("No such folder", "not_found");
        conditions.push(folder);
    }
    if (filters.personId) conditions.push(spokeIn(filters.personId));
    if (filters.entityId) {
        conditions.push(mentions(caller, filters.entityId));
    }
    return and(...conditions) as SQL;
}

/** A recording row as the filtered query loads it; `filename` is encrypted. */
export interface FilteredRecording {
    id: string;
    userId: string;
    filename: string;
    startTime: Date;
    /** Milliseconds. */
    duration: number;
}

/**
 * Up to `limit` recordings matching `where` (from
 * {@link recordingFilterConditions}), newest first (`startTime`, then
 * `id`), after the `before` keyset when given.
 */
export function loadFilteredRecordings(
    where: SQL,
    { before, limit }: { before: Keyset | null; limit: number },
): Promise<FilteredRecording[]> {
    return db
        .select({
            id: recordings.id,
            userId: recordings.userId,
            filename: chatterItems.title,
            startTime: chatterItems.occurredAt,
            duration: recordings.duration,
        })
        .from(recordings)
        .innerJoin(chatterItems, recordingItemJoin)
        .where(
            and(
                where,
                before
                    ? keysetBefore(
                          chatterItems.occurredAt,
                          recordings.id,
                          before,
                      )
                    : undefined,
            ),
        )
        .orderBy(...keysetOrder(chatterItems.occurredAt, recordings.id))
        .limit(limit);
}

/** The cursor that continues after `row` in newest-first order. */
export function recordingKeyset(row: FilteredRecording): string {
    return encodeKeyset({ at: row.startTime, id: row.id });
}

/**
 * The `batches` and `stampOf` of a `boundedScan` over the recordings
 * matching `where`: batches of {@link RECORDING_BATCH}, stamps are
 * keyset cursors. A `before` that is not a cursor throws
 * `McpToolError("Invalid cursor")`.
 */
export function recordingScanSource(where: SQL): {
    batches: (before: string | null) => Promise<FilteredRecording[]>;
    stampOf: (row: FilteredRecording) => string;
} {
    return {
        batches: (before) =>
            loadFilteredRecordings(where, {
                before: parseKeyset(before),
                limit: RECORDING_BATCH,
            }),
        stampOf: recordingKeyset,
    };
}

function speakerOrder(a: string, b: string): number {
    return a.localeCompare(b, "en", { numeric: true });
}

/**
 * The confirmed speakers' names of each recording, by recording id, as
 * the caller's view names them: its primary transcript (the caller's
 * preferred source first), the owner's naming in the private view, the
 * Organization's people alone in the Organization's.
 */
export async function recordingSpeakers(
    caller: McpCaller,
    rows: readonly Pick<FilteredRecording, "id" | "userId">[],
): Promise<Map<string, string[]>> {
    const names = new Map<string, string[]>();
    if (rows.length === 0) return names;
    const transcripts = await db
        .select({
            id: transcriptions.id,
            recordingId: transcriptions.recordingId,
            source: transcriptions.source,
        })
        .from(transcriptions)
        .innerJoin(
            recordings,
            and(
                eq(recordings.id, transcriptions.recordingId),
                eq(recordings.userId, transcriptions.userId),
            ),
        )
        .where(
            and(
                inArray(
                    transcriptions.recordingId,
                    rows.map((row) => row.id),
                ),
                mcpRecordingCondition(caller),
            ),
        )
        .orderBy(asc(transcriptions.createdAt), asc(transcriptions.id));
    if (transcripts.length === 0) return names;

    const preferred = await getPreferredTranscriptSource(treeUserId(caller));
    const byRecording = new Map<string, typeof transcripts>();
    for (const transcript of transcripts) {
        const held = byRecording.get(transcript.recordingId) ?? [];
        held.push(transcript);
        byRecording.set(transcript.recordingId, held);
    }
    const primary = new Map<string, string>();
    for (const [recordingId, held] of byRecording) {
        const pick =
            held.find((t) => t.source === preferred) ??
            held.find((t) => t.source === "riffado") ??
            held[0];
        if (pick) primary.set(pick.id, recordingId);
    }

    const owners = new Map(rows.map((row) => [row.id, row.userId]));
    const privateIds: string[] = [];
    const orgIds: string[] = [];
    for (const [transcriptionId, recordingId] of primary) {
        const owner = owners.get(recordingId) ?? "";
        if (recordingViewFor(caller, owner) === "private") {
            privateIds.push(transcriptionId);
        } else {
            orgIds.push(transcriptionId);
        }
    }
    const [labels, privateNames, orgNames] = await Promise.all([
        db
            .selectDistinct({
                transcriptionId: transcriptSpeakers.transcriptionId,
                label: transcriptSpeakers.label,
            })
            .from(transcriptSpeakers)
            .where(
                and(
                    inArray(transcriptSpeakers.transcriptionId, [
                        ...primary.keys(),
                    ]),
                    eq(transcriptSpeakers.status, "confirmed"),
                    isNotNull(transcriptSpeakers.personId),
                ),
            ),
        caller.kind === "user"
            ? buildResolverMap(caller.userId, privateIds)
            : Promise.resolve(new Map<string, SpeakerNameResolver>()),
        buildOrgResolverMap(orgIds),
    ]);
    const labelsOf = new Map<string, string[]>();
    for (const row of labels) {
        const held = labelsOf.get(row.transcriptionId) ?? [];
        held.push(row.label);
        labelsOf.set(row.transcriptionId, held);
    }
    for (const [transcriptionId, recordingId] of primary) {
        const resolve =
            privateNames.get(transcriptionId) ?? orgNames.get(transcriptionId);
        if (!resolve) continue;
        const found: string[] = [];
        for (const label of (labelsOf.get(transcriptionId) ?? []).sort(
            speakerOrder,
        )) {
            const name = resolve(label);
            if (name && !found.includes(name)) found.push(name);
        }
        if (found.length > 0) names.set(recordingId, found);
    }
    return names;
}
