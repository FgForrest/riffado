import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { recordings, recordingTasks } from "@/db/schema";
import type { ItemContent } from "@/lib/content/types";
import { decryptText } from "@/lib/encryption/fields";
import { getTranscriptSpeakers } from "@/lib/knowledge/attribution";
import { findByName, knowledgeView } from "@/lib/knowledge/knowledge-loader";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import {
    inferSummarySpeakerNumberOffset,
    offsetSpeakerLabel,
    projectSummarySpeakerReferencesForExport,
    speakerAnchorId,
} from "@/lib/knowledge/speaker-references";
import { heardIsFirstNameOnly } from "@/lib/learn/name-match";
import { type TaskViewer, taskClosable } from "@/lib/tasks/access";
import {
    buildTasksContext,
    recordingOffsetMinutes,
    type TasksContextTask,
} from "@/lib/tasks/directive";
import {
    locateQuote,
    locateTextQuote,
    normalizeTaskText,
} from "@/lib/tasks/quote";
import type {
    ProposedTask,
    ProposedTaskUpdate,
    TaskProposals,
} from "@/lib/tasks/store";
import type {
    SummaryTaskItem,
    SummaryTaskUpdate,
} from "@/lib/tasks/summary-items";
import type { TranscriptTurn } from "@/lib/transcription/turns";

/** Open tasks of a recording's speakers shown to its summary, at most. */
const MAX_OPEN_IN_PROMPT = 30;
/** Already-decided tasks of a recording shown to its summary, at most. */
const MAX_DECIDED_IN_PROMPT = 60;
/** A name match at least this good names the person (exact or every word). */
const NAME_MATCH_FLOOR = 0.9;

/** The keyed fingerprint a task proposal is recognised by, rejected or kept. */
export function taskFingerprint(text: string): string {
    return domainLookupHash("recording-task", normalizeTaskText(text));
}

export interface TasksPromptContext {
    /** Appended to the summary's system message. */
    text: string;
    /** The `T<n>` references the prompt used, to the tasks they stand for. */
    refs: Map<string, string>;
}

interface RecordingRow {
    id: string;
    userId: string;
    occurredAt: Date;
    timezone: number | null;
    zonemins: number | null;
}

/** Confirmed people on a transcript, by the anchor of their label. */
async function confirmedSpeakers(
    ownerUserId: string,
    transcriptionId: string,
    orgPeopleOnly: boolean,
): Promise<Map<string, { label: string; personId: string; name: string }>> {
    const rows = await getTranscriptSpeakers(ownerUserId, transcriptionId, {
        orgPeopleOnly,
    });
    const byAnchor = new Map<
        string,
        { label: string; personId: string; name: string }
    >();
    for (const row of rows) {
        if (row.status !== "confirmed" || !row.personId || !row.personName) {
            continue;
        }
        byAnchor.set(speakerAnchorId(row.label), {
            label: row.label,
            personId: row.personId,
            name: row.personName,
        });
    }
    return byAnchor;
}

/**
 * What a summary of `recording` is told about tasks: its date, the tasks
 * already decided on it, and the open tasks of the people speaking in it
 * that its reviewer may close (the organization account on a shared
 * recording, its owner otherwise), so whatever it hears about them can be
 * applied.
 */
export async function loadTasksPromptContext({
    recording,
    transcriptionId,
    orgView,
    reviewer,
    noun,
}: {
    recording: RecordingRow;
    /** The transcript its speakers are confirmed on; null for a mail. */
    transcriptionId: string | null;
    orgView: boolean;
    reviewer: TaskViewer;
    noun?: "recording" | "mail";
}): Promise<TasksPromptContext> {
    const decidedRows = await db
        .select({ text: recordingTasks.text })
        .from(recordingTasks)
        .where(
            and(
                eq(recordingTasks.itemId, recording.id),
                eq(recordingTasks.userId, recording.userId),
                ne(recordingTasks.status, "proposed"),
            ),
        )
        .orderBy(recordingTasks.position, recordingTasks.createdAt)
        .limit(MAX_DECIDED_IN_PROMPT);

    const speakers = transcriptionId
        ? await confirmedSpeakers(recording.userId, transcriptionId, orgView)
        : new Map<string, { label: string; personId: string; name: string }>();
    const labelOf = new Map(
        [...speakers.values()].map((speaker) => [
            speaker.personId,
            speaker.label,
        ]),
    );
    const refs = new Map<string, string>();
    const open: TasksContextTask[] = [];
    if (labelOf.size > 0) {
        const rows = await db
            .select({
                id: recordingTasks.id,
                text: recordingTasks.text,
                assigneePersonId: recordingTasks.assigneePersonId,
                dueDate: recordingTasks.dueDate,
            })
            .from(recordingTasks)
            .innerJoin(recordings, eq(recordings.id, recordingTasks.itemId))
            .where(
                and(
                    eq(recordingTasks.status, "open"),
                    inArray(recordingTasks.assigneePersonId, [
                        ...labelOf.keys(),
                    ]),
                    ne(recordingTasks.itemId, recording.id),
                    isNull(recordings.deletedAt),
                    taskClosable(reviewer),
                ),
            )
            .orderBy(desc(recordingTasks.createdAt))
            .limit(MAX_OPEN_IN_PROMPT);
        rows.forEach((row, index) => {
            const ref = `T${index + 1}`;
            refs.set(ref, row.id);
            open.push({
                ref,
                text: decryptText(row.text),
                speaker: row.assigneePersonId
                    ? (labelOf.get(row.assigneePersonId) ?? null)
                    : null,
                dueDate: row.dueDate,
            });
        });
    }

    return {
        text: buildTasksContext({
            noun,
            recordedAt: recording.occurredAt,
            offsetMinutes: recordingOffsetMinutes(
                recording.timezone,
                recording.zonemins,
            ),
            decided: decidedRows.map((row) => decryptText(row.text)),
            open,
        }),
        refs,
    };
}

/**
 * Turn a summary's items into proposals: a speaker label becomes the person
 * confirmed on it, a heard name the one person of the Almanac it fully
 * names (marked for a check when only a first name was heard), speaker
 * references in the text become names, and a quote its place in the audio.
 * On a mail a participant reference becomes their name to look up, and a
 * quote its place in the text, with its provenance.
 */
export async function resolveTaskProposals({
    source,
    items,
    updates,
    refs,
    ownerUserId,
    transcriptionId,
    turns,
    language,
    orgView,
    summaryText,
    mail = null,
}: {
    source: "riffado" | "plaud";
    items: readonly SummaryTaskItem[];
    updates: readonly SummaryTaskUpdate[];
    refs: ReadonlyMap<string, string>;
    ownerUserId: string;
    transcriptionId: string | null;
    turns: readonly TranscriptTurn[] | null;
    language: string | null;
    orgView: boolean;
    /** The summary's Markdown, to tell how its speaker numbers count. */
    summaryText: string;
    /** The content of the mail the summary is of. */
    mail?: ItemContent | null;
}): Promise<TaskProposals> {
    const participantOf = (ref: string) =>
        mail?.participants.find((participant) => participant.ref === ref);
    const participantName = (ref: string) =>
        participantOf(ref)?.displayName ?? null;
    const evidence = (quote: string | null) =>
        mail
            ? mailEvidence(mail, quote)
            : { evidenceStartMs: locateQuote(turns, quote) };
    const speakers = transcriptionId
        ? await confirmedSpeakers(ownerUserId, transcriptionId, orgView)
        : new Map<string, { label: string; personId: string; name: string }>();
    const nameOf = (label: string) =>
        speakers.get(speakerAnchorId(label))?.name ?? null;
    const offset = inferSummarySpeakerNumberOffset(
        [summaryText, ...items.map((item) => item.text)].join("\n"),
        (turns ?? []).map((turn) => turn.speaker),
    );

    const needsLookup = items.some(
        (item) =>
            (!item.speaker && item.assignee) ||
            (mail && item.speaker && participantName(item.speaker)),
    );
    const view = needsLookup
        ? await knowledgeView({
              kind: "recording",
              ownerUserId,
              shared: orgView,
          })
        : null;

    const tasks: ProposedTask[] = [];
    for (const item of items) {
        const text = projectSummarySpeakerReferencesForExport(
            item.text,
            nameOf,
            offset,
        ).trim();
        if (!text) continue;
        let assigneePersonId: string | null = null;
        let assigneeHint: string | null = null;
        let assigneeCheck = false;
        const heard = mail
            ? (item.assignee ??
              (item.speaker ? participantName(item.speaker) : null))
            : null;
        const known =
            mail && item.speaker ? participantOf(item.speaker) : undefined;
        if (known?.personId) {
            // The participant's address is the person's: no guess.
            assigneePersonId = known.personId;
        } else if (mail) {
            const person =
                heard && view ? matchPerson(view, heard, language) : null;
            if (person) {
                assigneePersonId = person.id;
                assigneeCheck = heardIsFirstNameOnly(heard ?? "", {
                    name: person.name,
                    aliases: person.aliases,
                });
            } else {
                assigneeHint = heard;
            }
        } else if (item.speaker) {
            const speaker = speakers.get(
                speakerAnchorId(offsetSpeakerLabel(item.speaker, offset)),
            );
            if (speaker) {
                assigneePersonId = speaker.personId;
                // The summary counted its speakers from 1: worth a look.
                assigneeCheck = offset !== 0;
            }
        } else if (item.assignee && view) {
            const person = matchPerson(view, item.assignee, language);
            if (person) {
                assigneePersonId = person.id;
                assigneeCheck = heardIsFirstNameOnly(item.assignee, {
                    name: person.name,
                    aliases: person.aliases,
                });
            } else {
                assigneeHint = item.assignee;
            }
        }
        tasks.push({
            text,
            fingerprint: taskFingerprint(text),
            assigneePersonId,
            assigneeHint,
            assigneeCheck,
            dueDate: item.due?.date ?? null,
            duePhrase: item.due?.phrase ?? null,
            quote: item.quote,
            ...evidence(item.quote),
        });
    }

    const proposedUpdates: ProposedTaskUpdate[] = [];
    for (const update of updates) {
        const taskId = refs.get(update.ref);
        if (!taskId) continue;
        proposedUpdates.push({
            taskId,
            kind: update.kind,
            dueDate: update.due?.date ?? null,
            duePhrase: update.due?.phrase ?? null,
            quote: update.quote,
            ...evidence(update.quote),
        });
    }

    return {
        source,
        tasks,
        updates: proposedUpdates,
        fingerprintOf: taskFingerprint,
    };
}

/**
 * Where in a mail a quote is, and how far to trust it: a quoted part was
 * written by someone else earlier, and a sender nothing verified may not be
 * who they say.
 */
function mailEvidence(
    mail: ItemContent,
    quote: string | null,
): Pick<
    ProposedTask,
    "evidenceStartMs" | "evidenceText" | "evidenceProvenance"
> {
    const range = locateTextQuote(
        mail.segments.filter(
            (segment) => !segment.knownItemId && segment.role !== "disclaimer",
        ),
        quote,
    );
    const segment = range
        ? mail.segments.find((item) => item.index === range.segmentIndex)
        : undefined;
    const author = segment?.participantRef
        ? mail.participants.find(
              (participant) => participant.ref === segment.participantRef,
          )
        : undefined;
    const provenance =
        segment?.role === "quoted" || segment?.role === "quoted_signature"
            ? "quoted"
            : segment && !author?.authenticated
              ? "unverified"
              : null;
    return {
        evidenceStartMs: null,
        evidenceText: range,
        evidenceProvenance: provenance,
    };
}

function matchPerson(
    view: Awaited<ReturnType<typeof knowledgeView>>,
    heard: string,
    language: string | null,
): { id: string; name: string; aliases: string[] } | null {
    const people = new Map(
        view.items
            .filter((item) => item.kind === "person")
            .map((item) => [item.id, item]),
    );
    const matches = findByName(view, heard, language).filter(
        (match) => people.has(match.id) && match.score >= NAME_MATCH_FLOOR,
    );
    const [best, second] = matches;
    if (!best || (second && second.score === best.score)) return null;
    const person = people.get(best.id);
    if (!person) return null;
    return {
        id: person.id,
        name: person.name,
        aliases: person.names
            .filter((name) => name.kind === "alias")
            .map((name) => name.text),
    };
}
