/**
 * Parsing of the JSON object a summary model is asked to return.
 *
 * Extracted from `generate-summary.ts` because multi-pass summarization needs
 * to parse each pass independently and decide which ones are fit to merge.
 */

export interface SummaryPayload {
    summary: string;
    keyPoints: string[];
    actionItems: string[];
    /**
     * False when the reply was not JSON at all and `summary` holds the raw
     * text instead.
     *
     * The single-pass path treats both cases the same -- a raw answer is
     * still shown to the user. Multi-pass cannot: feeding prose to a merge
     * step that was told it is receiving `{summary, keyPoints, actionItems}`
     * objects invites the model to invent the missing structure. So the flag
     * exists to let the merge drop what it cannot honestly merge.
     */
    structured: boolean;
}

/**
 * Coerce a parsed `keyPoints` / `actionItems` value into the `string[]` that
 * the column type, the API response and the render path all assume.
 *
 * `Array.isArray` on its own was not enough. Models -- especially smaller ones
 * and OpenAI-compatible shims -- answer with `[{ owner, task }]` instead of
 * `["[owner] task"]`, and the old check waved any array through. The objects
 * were encrypted, stored, and later reached `point.slice(0, 32)` in the key
 * points list, so a single malformed response made that recording throw
 * `point.slice is not a function` on every open, permanently, with nothing in
 * the UI to explain it or undo it.
 *
 * Non-strings are stringified rather than dropped: a visibly wrong entry can be
 * regenerated, whereas silently discarding it looks exactly like the model
 * finding nothing to report.
 */
export function toStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            if (entry.trim()) out.push(entry);
        } else if (entry !== null && entry !== undefined) {
            out.push(
                typeof entry === "object"
                    ? JSON.stringify(entry)
                    : String(entry),
            );
        }
    }
    return out;
}

/**
 * Parse one model reply into a summary payload.
 *
 * Never throws: an unparseable reply comes back as `structured: false` with the
 * raw text as the summary, which is what the single-pass path has always shown
 * rather than failing the request outright.
 */
export function parseSummaryPayload(rawContent: string): SummaryPayload {
    const raw = rawContent.trim();
    try {
        // Models fence their JSON despite being told not to, often enough
        // that stripping it is part of parsing rather than an edge case.
        const cleanContent = raw
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();
        const parsed = JSON.parse(cleanContent);
        if (parsed === null || typeof parsed !== "object") {
            // Valid JSON, but a scalar -- `"hello"` parses fine and would
            // otherwise yield a payload with no fields and no raw text.
            return {
                summary: raw,
                keyPoints: [],
                actionItems: [],
                structured: false,
            };
        }
        // A parsed object with no usable `summary` key still counts as
        // structured: some models return only `{keyPoints, actionItems}`,
        // and those lists are worth keeping. The raw text stands in for the
        // prose so the recording is never left with a blank summary.
        return {
            summary:
                typeof parsed.summary === "string" && parsed.summary.trim()
                    ? parsed.summary
                    : raw,
            keyPoints: toStringList(parsed.keyPoints),
            actionItems: toStringList(parsed.actionItems),
            structured: true,
        };
    } catch {
        return {
            summary: raw,
            keyPoints: [],
            actionItems: [],
            structured: false,
        };
    }
}
