/**
 * Multi-pass summarization: run the summary prompt several times in parallel,
 * then merge the results into one.
 *
 * The point is RECALL, not accuracy. Independent passes over the same
 * transcript omit different things, so their union omits less. No pass is more
 * likely to be right than any other, and the merge can introduce drift of its
 * own -- which is why the setting is named "multi-pass" and the UI never
 * promises a better summary, only a more complete one.
 *
 * This module runs no HTTP of its own. The caller injects `runPass` and
 * `runMerge`, so the orchestration -- which is all the behaviour worth testing
 * -- can be exercised without a provider, a network, or a mock of the OpenAI
 * client.
 */

import { parseSummaryPayload, type SummaryPayload } from "./payload";

/**
 * Rounds are clamped rather than free-form. One pass is not multi-pass (the
 * caller should take the single-pass path instead), and every pass re-sends
 * the whole transcript, so a large N on a long recording is simultaneously a
 * bill, a long wait, and -- against a subscription-backed provider -- a
 * self-inflicted rate limit shared with the user's own sessions.
 */
export const MULTI_PASS_ROUNDS_MIN = 2;
export const MULTI_PASS_ROUNDS_MAX = 5;
export const MULTI_PASS_ROUNDS_DEFAULT = 3;

export function clampRounds(rounds: unknown): number {
    const n = Math.trunc(Number(rounds));
    if (!Number.isFinite(n)) return MULTI_PASS_ROUNDS_DEFAULT;
    return Math.min(Math.max(n, MULTI_PASS_ROUNDS_MIN), MULTI_PASS_ROUNDS_MAX);
}

/**
 * The built-in merge prompt, used whenever the user has not written their own.
 *
 * Derived from the prompt in Dzoukr/RiffadoDocker, which established the
 * framing that does most of the work here: stating outright that this is a
 * union, not a second round of summarizing. Two rules are added. The first is
 * a conflict rule -- "never invent" says nothing about what to do when two
 * passes report different numbers, and without guidance the model quietly
 * picks one. The second makes the dedup bias explicit, because a merge told
 * only to "collapse duplicates" tends to collapse near-duplicates too, which
 * is the exact loss the feature exists to prevent.
 */
export const DEFAULT_MERGE_PROMPT = `You are given several independent JSON extractions produced from the SAME transcript, each shaped {"summary": string, "keyPoints": string[], "actionItems": string[]}. Merge them into a single extraction. This is a UNION-and-DEDUP task, NOT a re-summarization.

- Preserve EVERY distinct key point and action item that appears in ANY version. Never drop one for being minor, or for appearing in only one version.
- Collapse entries expressing the same idea into one, keeping the clearest and most complete phrasing. Merge only true duplicates: if two entries differ in substance, keep both. When in doubt, keep both -- a redundant entry costs the reader a moment, a dropped one costs them the information.
- Never invent a point, detail, owner, or action that is not present in at least one input.
- When versions CONFLICT on a detail (a number, a date, a name, an owner), prefer the reading that is more specific and that appears in more than one version. If they cannot be reconciled, keep both readings in one entry rather than silently choosing.
- For "summary", write one coherent paragraph covering what the versions agree on. Introduce no claim absent from the inputs.
- Keep each entry in the language it was written in.
- Entries sharing a topic or owner in [brackets] must be listed together ([A], [A], [B] -- not [A], [B], [A]). Entries with no bracket go last.
- Where topics nest, use a second bracket level: [Feedback] [John], [Feedback] [Peter] -- not [Feedback - John], [Feedback - Peter].
- If no version had entries for a list, return that list empty. Never fill it with placeholders such as "None".

Return only the merged JSON object, with no markdown and no code fences.`;

export type MultiPassPhase = "passes" | "merging";

export interface MultiPassProgress {
    phase: MultiPassPhase;
    /** Passes finished so far (settled, not necessarily successful). */
    completed: number;
    /** Passes requested. */
    total: number;
}

export interface RunMultiPassOptions {
    /** Clamped by the caller via `clampRounds`. */
    rounds: number;
    /** Runs one summary pass, resolving with the model's raw reply. */
    runPass: () => Promise<string>;
    /** Runs the merge, resolving with the model's raw reply. */
    runMerge: (mergeInput: string, mergePrompt: string) => Promise<string>;
    /** Defaults to `DEFAULT_MERGE_PROMPT` when blank. */
    mergePrompt?: string | null;
    onProgress?: (progress: MultiPassProgress) => void;
}

export interface MultiPassResult {
    payload: SummaryPayload;
    roundsRequested: number;
    /** Passes that returned a parseable object. */
    passesUsed: number;
    merged: boolean;
    /** Short human string for logs and analytics. */
    detail: string;
}

/**
 * Rank passes so the fallbacks pick the most informative one.
 *
 * Entry count first, summary length only as a tiebreak: a pass that found two
 * more action items is more useful than one that wrote a longer paragraph, and
 * ranking by raw text length alone rewards verbosity.
 */
function richest(payloads: SummaryPayload[]): SummaryPayload {
    return payloads.reduce((best, candidate) => {
        const bestEntries = best.keyPoints.length + best.actionItems.length;
        const candidateEntries =
            candidate.keyPoints.length + candidate.actionItems.length;
        if (candidateEntries !== bestEntries) {
            return candidateEntries > bestEntries ? candidate : best;
        }
        return candidate.summary.length > best.summary.length
            ? candidate
            : best;
    });
}

/** Format the surviving passes as the merge step's user message. */
export function buildMergeInput(payloads: SummaryPayload[]): string {
    return payloads
        .map((payload, index) => {
            const version = JSON.stringify(
                {
                    summary: payload.summary,
                    keyPoints: payload.keyPoints,
                    actionItems: payload.actionItems,
                },
                null,
                2,
            );
            return `Version ${index + 1}:\n${version}`;
        })
        .join("\n\n");
}

/**
 * Run the passes, then merge.
 *
 * Degrades rather than fails, at every step. Multi-pass makes N provider calls
 * where one used to be made, so without this it would be N times more likely
 * to fail than the single-pass path -- a strictly worse product sold as an
 * improvement. The ladder:
 *
 *   - every pass rejected      -> rethrow the first rejection (nothing to show)
 *   - no pass returned JSON    -> richest raw reply, unmerged (a merge told it
 *                                 is receiving objects cannot honestly be
 *                                 handed prose)
 *   - exactly one usable pass  -> that pass, unmerged
 *   - merge rejects or returns
 *     something unparseable    -> richest usable pass
 *
 * Only the first case is an error. Every other path returns a summary the user
 * can read.
 */
export async function runMultiPassSummary(
    options: RunMultiPassOptions,
): Promise<MultiPassResult> {
    const { rounds, runPass, runMerge, onProgress } = options;
    const mergePrompt = options.mergePrompt?.trim() || DEFAULT_MERGE_PROMPT;

    let completed = 0;
    onProgress?.({ phase: "passes", completed: 0, total: rounds });

    // All passes start together; progress is reported as each settles, so the
    // UI ticks on real completions rather than on a timer.
    const settled = await Promise.allSettled(
        Array.from({ length: rounds }, () =>
            runPass().finally(() => {
                completed += 1;
                onProgress?.({
                    phase: "passes",
                    completed,
                    total: rounds,
                });
            }),
        ),
    );

    const fulfilled = settled.filter(
        (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
    );

    if (fulfilled.length === 0) {
        const firstRejection = settled.find(
            (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        throw firstRejection?.reason instanceof Error
            ? firstRejection.reason
            : new Error("Every summary pass failed");
    }

    const parsed = fulfilled.map((r) => parseSummaryPayload(r.value));
    const usable = parsed.filter((p) => p.structured);

    if (usable.length === 0) {
        return {
            payload: richest(parsed),
            roundsRequested: rounds,
            passesUsed: 0,
            merged: false,
            detail: `${fulfilled.length}/${rounds} passes, none parseable, no merge`,
        };
    }

    if (usable.length === 1) {
        return {
            payload: usable[0],
            roundsRequested: rounds,
            passesUsed: 1,
            merged: false,
            detail: `1/${rounds} passes usable, no merge`,
        };
    }

    onProgress?.({
        phase: "merging",
        completed: fulfilled.length,
        total: rounds,
    });

    try {
        const mergedRaw = await runMerge(buildMergeInput(usable), mergePrompt);
        const mergedPayload = parseSummaryPayload(mergedRaw);
        if (!mergedPayload.structured) {
            return {
                payload: richest(usable),
                roundsRequested: rounds,
                passesUsed: usable.length,
                merged: false,
                detail: `${usable.length}/${rounds} passes, merge unparseable -> richest pass`,
            };
        }
        return {
            payload: mergedPayload,
            roundsRequested: rounds,
            passesUsed: usable.length,
            merged: true,
            detail: `${usable.length}/${rounds} passes + merge`,
        };
    } catch {
        return {
            payload: richest(usable),
            roundsRequested: rounds,
            passesUsed: usable.length,
            merged: false,
            detail: `${usable.length}/${rounds} passes, merge failed -> richest pass`,
        };
    }
}
