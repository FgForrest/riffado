import {
    renderTurnsAsText,
    type TranscriptTurn,
    turnsFromLabelledSegments,
} from "@/lib/transcription/turns";
import type {
    PlaudContentItem,
    PlaudFileDetailResponse,
    PlaudTranscriptSegment,
} from "@/types/plaud";

/**
 * Pure parsers for Plaud-native content (`GET /file/detail/{fileId}` →
 * `content_list[]`, plus the presigned-link / inline payloads). No network or
 * client dependency, so they're unit-testable against fixtures.
 *
 * Item selection and the summary/envelope shape are validated against a real
 * captured `/file/detail` response (#204). The transcript *segment* body
 * (`trans_result.json.gz`) is still UNVERIFIED — `parseTranscript` stays
 * deliberately defensive until a real transcript payload is captured.
 *
 * Observed `content_list` item types: `transaction` (transcript),
 * `auto_sum_note` (the primary "Summary"), `sum_multi_note` (secondary
 * template notes), `outline`. The `data_type` strings are not stable, so
 * selection also matches on the `data_id` prefix
 * (`source_transaction:` / `auto_sum:` / `sum_multi:`).
 */

const TRANSCRIPT_TYPES = new Set(["transaction", "transcript"]);
const TRANSCRIPT_ID_PREFIXES = ["source_transaction:"];
// Primary summary first (the "Summary" tab), then secondary template notes.
const SUMMARY_TYPES = new Set([
    "auto_sum_note",
    "sum_multi_note",
    "summary",
    "note",
    "ai_summary",
]);
const SUMMARY_ID_PREFIXES = ["auto_sum:", "sum_multi:"];
const PRIMARY_SUMMARY_ID_PREFIX = "auto_sum:";

function matches(
    item: PlaudContentItem,
    types: Set<string>,
    idPrefixes: string[],
): boolean {
    const type = (item.data_type ?? "").toLowerCase();
    if (types.has(type)) return true;
    const id = item.data_id ?? "";
    return idPrefixes.some((p) => id.startsWith(p));
}

function isPrimarySummary(item: PlaudContentItem): boolean {
    const type = (item.data_type ?? "").toLowerCase();
    return (
        type === "auto_sum_note" ||
        (item.data_id ?? "").startsWith(PRIMARY_SUMMARY_ID_PREFIX)
    );
}

export interface SelectedContent {
    transcript?: PlaudContentItem;
    summary?: PlaudContentItem;
}

/**
 * Pick the transcript and summary items from `content_list`. The transcript
 * is the first transaction-like item. For summaries we prefer the primary
 * auto-generated one (`auto_sum_note`) over secondary template notes
 * (`sum_multi_note`), falling back to whatever summary-like item appears first.
 */
export function selectContentItems(
    detail: PlaudFileDetailResponse,
): SelectedContent {
    const items = detail.data?.content_list ?? [];
    const selected: SelectedContent = {};
    let fallbackSummary: PlaudContentItem | undefined;
    for (const item of items) {
        if (
            !selected.transcript &&
            matches(item, TRANSCRIPT_TYPES, TRANSCRIPT_ID_PREFIXES)
        ) {
            selected.transcript = item;
        } else if (matches(item, SUMMARY_TYPES, SUMMARY_ID_PREFIXES)) {
            if (!selected.summary && isPrimarySummary(item)) {
                selected.summary = item;
            } else if (!fallbackSummary) {
                fallbackSummary = item;
            }
        }
    }
    selected.summary ??= fallbackSummary;
    return selected;
}

/**
 * Some content (notably the primary `auto_sum` summary) is delivered inline in
 * `pre_download_content_list[].data_content` as a JSON string, so it can be
 * imported without a presigned-S3 round-trip (and without risking presign
 * expiry, #203). Returns the parsed inline payload for a content item, or
 * `undefined` when there is no inline copy.
 */
export function findInlineContent(
    detail: PlaudFileDetailResponse,
    dataId: string | undefined,
): unknown {
    if (!dataId) return undefined;
    const list = detail.data?.pre_download_content_list ?? [];
    const entry = list.find((e) => e.data_id === dataId);
    if (!entry || typeof entry.data_content !== "string") return undefined;
    try {
        return JSON.parse(entry.data_content);
    } catch {
        return entry.data_content;
    }
}

/**
 * A content item is importable only when Plaud has finished processing it
 * (`task_status === 1`) and it actually carries a fetchable link.
 */
export function isReady(item: PlaudContentItem | undefined): boolean {
    return Boolean(item && item.task_status === 1 && item.data_link);
}

export interface ParsedTranscript {
    text: string;
    segments: PlaudTranscriptSegment[];
    language: string | null;
}

/**
 * Parse a 'transaction' content payload into flattened, speaker-prefixed text
 * plus the structured segments. Accepts either a bare segment array or an
 * object that wraps one.
 */
/**
 * Convert Plaud segments into transcript turns.
 *
 * Plaud does not document whether segment times are seconds or milliseconds
 * and both appear in the wild, so the unit is inferred from the recording's
 * own duration rather than assumed: both hypotheses are projected to an end
 * time and the one landing nearer `durationMs` wins. A one-sided "is it small
 * against the duration" test would misread already-millisecond times on a
 * mostly silent recording, where speech stops long before the tape does.
 * Without a duration to compare against, values are taken as milliseconds,
 * which is the unit `PlaudRecording.duration` uses.
 */
export function segmentsToTurns(
    segments: readonly PlaudTranscriptSegment[],
    durationMs?: number,
): TranscriptTurn[] | null {
    const maxTime = segments.reduce(
        (latest, seg) => Math.max(latest, seg.end_time ?? seg.start_time ?? 0),
        0,
    );
    const inSeconds =
        typeof durationMs === "number" &&
        durationMs > 0 &&
        maxTime > 0 &&
        Math.abs(maxTime * 1000 - durationMs) < Math.abs(maxTime - durationMs);
    const scale = inSeconds ? 1000 : 1;

    return turnsFromLabelledSegments(
        segments.map((seg) => {
            const start = Math.round((seg.start_time ?? 0) * scale);
            return {
                speaker: speakerLabel(seg.speaker),
                startMs: start,
                endMs:
                    seg.end_time === undefined
                        ? start
                        : Math.round(seg.end_time * scale),
                text: (seg.content ?? "").trim(),
            };
        }),
    );
}

/** The label `parseTranscript` writes into the flat text, or "" for none. */
function speakerLabel(speaker: string | number | undefined | null): string {
    if (speaker === undefined || speaker === null || speaker === "") return "";
    return typeof speaker === "number" ? `Speaker ${speaker}` : speaker;
}

export function parseTranscript(raw: unknown): ParsedTranscript {
    const segments = extractSegments(raw);
    // Rendered from the same grouping the stored turns come from, so the flat
    // text and the turns can never disagree about where a turn ends. Timings
    // play no part in the rendering, so no duration is needed here.
    const turns = segmentsToTurns(segments);
    return {
        text: turns ? renderTurnsAsText(turns) : "",
        segments,
        language: extractLanguage(raw),
    };
}

export interface ParsedSummary {
    summary: string;
    keyPoints: string[];
    actionItems: string[];
}

/**
 * Parse a 'summary'/'note' content payload. Accepts a bare string or an object
 * keyed by any of several known field names.
 */
export function parseSummary(raw: unknown): ParsedSummary {
    if (typeof raw === "string") {
        return { summary: raw.trim(), keyPoints: [], actionItems: [] };
    }
    if (!raw || typeof raw !== "object") {
        return { summary: "", keyPoints: [], actionItems: [] };
    }
    const obj = raw as Record<string, unknown>;
    const summary =
        pickString(obj.ai_content) ??
        pickString(obj.summary) ??
        pickString(obj.content) ??
        "";
    return {
        summary: summary.trim(),
        keyPoints: pickStringArray(
            obj.key_points ?? obj.keyPoints ?? obj.highlights,
        ),
        actionItems: pickStringArray(
            obj.action_items ?? obj.actionItems ?? obj.todos,
        ),
    };
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function extractSegments(raw: unknown): PlaudTranscriptSegment[] {
    let arr: unknown[] = [];
    if (Array.isArray(raw)) {
        arr = raw;
    } else if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        arr =
            asArray(obj.segments).length > 0
                ? asArray(obj.segments)
                : asArray(obj.transcript).length > 0
                  ? asArray(obj.transcript)
                  : asArray(obj.data);
    }
    return arr
        .filter(
            (s): s is Record<string, unknown> =>
                Boolean(s) && typeof s === "object",
        )
        .map((s) => ({
            start_time:
                typeof s.start_time === "number" ? s.start_time : undefined,
            end_time: typeof s.end_time === "number" ? s.end_time : undefined,
            speaker:
                typeof s.speaker === "string" || typeof s.speaker === "number"
                    ? s.speaker
                    : undefined,
            content:
                typeof s.content === "string"
                    ? s.content
                    : typeof s.text === "string"
                      ? s.text
                      : undefined,
        }));
}

function extractLanguage(raw: unknown): string | null {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const lang = (raw as Record<string, unknown>).language;
        if (typeof lang === "string" && lang.trim()) return lang.trim();
    }
    return null;
}

function pickString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function pickStringArray(value: unknown): string[] {
    return asArray(value).filter((v): v is string => typeof v === "string");
}
