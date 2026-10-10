/**
 * The action items and task updates a summary model returns, read
 * tolerantly: an object per item as `SUMMARY_TASKS_DIRECTIVE` asks, or a
 * plain string from a prompt or a model that ignored it (and from Plaud).
 * Pure, so the payload parser and the tests use it without the database.
 */

export interface SummaryTaskDue {
    /** The deadline as it was said. */
    phrase: string;
    /** `YYYY-MM-DD`, or null when the phrase names no day. */
    date: string | null;
}

export interface SummaryTaskItem {
    text: string;
    /**
     * Who has to do it: a transcript label (`speaker_N`), or a mail
     * participant's reference (`pN`).
     */
    speaker: string | null;
    /** A name heard for someone who does not speak. */
    assignee: string | null;
    due: SummaryTaskDue | null;
    /** A few words of the transcript it was heard in. */
    quote: string | null;
}

export interface SummaryTaskUpdate {
    /** The `T<n>` reference of an open task the prompt listed. */
    ref: string;
    kind: "done" | "due";
    /** The new deadline, for `due`. */
    due: SummaryTaskDue | null;
    quote: string | null;
}

const MAX_TEXT = 500;
const MAX_FIELD = 200;
const MAX_ITEMS = 60;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SPEAKER_LABEL = /^speaker[_ -]?(\d+)$/i;
const PARTICIPANT_REF = /^p(\d{1,3})$/i;
const LEADING_SPEAKER = /^\s*\[Speaker (\d+)\]\(#speaker-\1\)\s*/;
const SPEAKER_PLACEHOLDER = /^\[?Speaker (\d+)\]?(?:\(#speaker-\1\))?$/i;

function cleanString(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

/** A real calendar day in `YYYY-MM-DD`, or null. */
export function isoDateOrNull(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const match = ISO_DATE.exec(value.trim());
    if (!match) return null;
    const [, year, month, day] = match;
    const date = new Date(
        Date.UTC(Number(year), Number(month) - 1, Number(day)),
    );
    return date.getUTCFullYear() === Number(year) &&
        date.getUTCMonth() === Number(month) - 1 &&
        date.getUTCDate() === Number(day)
        ? `${year}-${month}-${day}`
        : null;
}

/**
 * `speaker_N` from what a model wrote for a speaker, or `pN` for a mail
 * participant; null otherwise.
 */
export function speakerLabelOf(value: unknown): string | null {
    const text = cleanString(value, MAX_FIELD);
    if (!text) return null;
    const participant = PARTICIPANT_REF.exec(text);
    if (participant) return `p${Number(participant[1])}`;
    const label = SPEAKER_LABEL.exec(text) ?? SPEAKER_PLACEHOLDER.exec(text);
    return label ? `speaker_${label[1]}` : null;
}

function readDue(value: unknown): SummaryTaskDue | null {
    if (typeof value === "string") {
        const date = isoDateOrNull(value);
        const phrase = cleanString(value, MAX_FIELD);
        return phrase ? { phrase, date } : null;
    }
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const date = isoDateOrNull(record.date);
    const phrase = cleanString(record.phrase, MAX_FIELD) ?? date;
    return phrase ? { phrase, date } : null;
}

/**
 * One item from a string: a leading speaker reference names who does it
 * ("[Speaker 2](#speaker-2) to draft the page"), and stays in the text.
 */
function itemFromString(entry: string): SummaryTaskItem | null {
    const text = entry.trim().slice(0, MAX_TEXT);
    if (!text) return null;
    const leading = LEADING_SPEAKER.exec(text);
    return {
        text,
        speaker: leading ? `speaker_${leading[1]}` : null,
        assignee: null,
        due: null,
        quote: null,
    };
}

function itemFromObject(
    record: Record<string, unknown>,
): SummaryTaskItem | null {
    const text =
        cleanString(record.text, MAX_TEXT) ??
        cleanString(record.task, MAX_TEXT) ??
        cleanString(record.action, MAX_TEXT);
    if (!text) return null;
    const owner = record.assignee ?? record.owner;
    const speaker = speakerLabelOf(record.speaker) ?? speakerLabelOf(owner);
    return {
        text,
        speaker,
        assignee: speaker ? null : cleanString(owner, MAX_FIELD),
        due: readDue(record.due ?? record.dueDate ?? record.deadline),
        quote: cleanString(record.quote, MAX_FIELD),
    };
}

function itemFromEntry(entry: unknown): SummaryTaskItem | null {
    if (entry === null || entry === undefined) return null;
    if (typeof entry === "string") return itemFromString(entry);
    if (typeof entry !== "object") return itemFromString(String(entry));
    const item = Array.isArray(entry)
        ? null
        : itemFromObject(entry as Record<string, unknown>);
    return item ?? itemFromString(JSON.stringify(entry));
}

/**
 * The action items of a parsed reply, whatever shape each one has. An entry
 * with no text of a known name is kept as its JSON: a visibly odd item can
 * be dropped in review, a silently missing one looks like nothing was said.
 */
export function readTaskItems(value: unknown): SummaryTaskItem[] {
    if (!Array.isArray(value)) return [];
    const items: SummaryTaskItem[] = [];
    for (const entry of value) {
        if (items.length >= MAX_ITEMS) break;
        const item = itemFromEntry(entry);
        if (item) items.push(item);
    }
    return items;
}

/** The task updates of a parsed reply; anything malformed is dropped. */
export function readTaskUpdates(value: unknown): SummaryTaskUpdate[] {
    if (!Array.isArray(value)) return [];
    const updates: SummaryTaskUpdate[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (updates.length >= MAX_ITEMS) break;
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const ref = cleanString(record.ref, 16);
        const kind = record.kind;
        if (!ref || (kind !== "done" && kind !== "due")) continue;
        const due = kind === "due" ? readDue(record.due ?? record.date) : null;
        if (kind === "due" && !due?.date) continue;
        const key = `${ref}\u0000${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        updates.push({
            ref,
            kind,
            due,
            quote: cleanString(record.quote, MAX_FIELD),
        });
    }
    return updates;
}

/**
 * The one line the summary's `actionItems` keeps for an item, for the
 * readers of that list (the API, exports of summaries made before tasks):
 * who, what, and by when, as they were said.
 */
export function taskItemLine(item: SummaryTaskItem): string {
    const number = item.speaker ? SPEAKER_LABEL.exec(item.speaker)?.[1] : null;
    const who = number
        ? `[Speaker ${number}](#speaker-${number})`
        : item.assignee;
    const text =
        who && !item.text.startsWith(who) ? `${who}: ${item.text}` : item.text;
    return item.due ? `${text} (${item.due.phrase})` : text;
}
