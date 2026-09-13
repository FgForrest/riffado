/**
 * Why a degraded multi-pass run was previously undiagnosable.
 *
 * `passesUsed` counts passes that returned a PARSEABLE OBJECT, so a badge
 * reading "2/3" covers two quite different events: a pass that rejected, and a
 * pass that answered with something that would not parse. Neither was logged.
 * `onRetry` -- the only log on that path -- fires only when `retryWithBackoff`
 * is about to wait, so a pass that failed once with a non-retryable error was
 * as silent as one whose reply was prose.
 *
 * `detail` was computed for all five outcomes and read by nothing.
 *
 * These pin the diagnosis, and pin that it carries no model output: a pass
 * reply summarises the user's recording, so an unusable one is described by
 * shape, never quoted.
 */

import { describe, expect, it } from "vitest";
import {
    formatPassOutcomes,
    type PassOutcome,
    runMultiPassSummary,
} from "@/lib/summary/multi-pass";

const GOOD = JSON.stringify({
    summary: "s",
    keyPoints: ["k"],
    actionItems: [],
});

/** Resolves the queued replies in order; a reply of `null` rejects. */
function passesFrom(replies: (string | Error)[]) {
    let index = 0;
    return () => {
        const reply = replies[index++];
        return reply instanceof Error
            ? Promise.reject(reply)
            : Promise.resolve(reply);
    };
}

const mergeOk = async () => GOOD;

describe("pass outcomes", () => {
    it("records one outcome per requested pass", async () => {
        const result = await runMultiPassSummary({
            rounds: 3,
            runPass: passesFrom([GOOD, GOOD, GOOD]),
            runMerge: mergeOk,
        });
        expect(result.passOutcomes).toHaveLength(3);
        expect(result.passOutcomes.every((o) => o.status === "usable")).toBe(
            true,
        );
        expect(result.detail).toBe("3/3 passes + merge");
    });

    it("distinguishes a rejected pass from an unparseable one", async () => {
        // The exact ambiguity a "2/3" badge leaves behind.
        const result = await runMultiPassSummary({
            rounds: 3,
            runPass: passesFrom([
                GOOD,
                new Error("socket hang up"),
                "Sure! Here is the summary you asked for.",
            ]),
            runMerge: mergeOk,
        });
        expect(result.passesUsed).toBe(1);
        expect(result.passOutcomes[0]).toEqual({ status: "usable" });
        expect(result.passOutcomes[1]).toMatchObject({ status: "rejected" });
        expect(result.passOutcomes[2]).toMatchObject({
            status: "unparseable",
        });
    });

    it("keeps a rejected pass in its own slot", async () => {
        // Built over the settled results rather than the survivors: otherwise
        // a rejected pass is simply absent and the list silently shortens.
        const result = await runMultiPassSummary({
            rounds: 3,
            runPass: passesFrom([new Error("boom"), GOOD, GOOD]),
            runMerge: mergeOk,
        });
        expect(result.passOutcomes).toHaveLength(3);
        expect(result.passOutcomes[0].status).toBe("rejected");
    });

    it("describes an unusable reply by shape, never by content", async () => {
        const secret = "The board agreed to acquire Initech for 4.2 million.";
        const result = await runMultiPassSummary({
            rounds: 2,
            runPass: passesFrom([GOOD, secret]),
            runMerge: mergeOk,
        });
        const outcome = result.passOutcomes[1];
        expect(outcome).toEqual({
            status: "unparseable",
            replyChars: secret.length,
            startsWith: "T",
        });
        expect(JSON.stringify(result.passOutcomes)).not.toContain("Initech");
    });

    it("tells a truncated object from prose by its opening character", async () => {
        // A reply cut off at the token ceiling still opens with "{"; a CLI
        // preamble or a refusal opens with a letter.
        const truncated = `{"summary": "a long summary that never clo`;
        const result = await runMultiPassSummary({
            rounds: 2,
            runPass: passesFrom([GOOD, truncated]),
            runMerge: mergeOk,
        });
        expect(result.passOutcomes[1]).toMatchObject({ startsWith: "{" });
    });

    it("marks an empty reply rather than an empty string", async () => {
        const result = await runMultiPassSummary({
            rounds: 2,
            runPass: passesFrom([GOOD, "   "]),
            runMerge: mergeOk,
        });
        expect(result.passOutcomes[1]).toMatchObject({
            startsWith: "(empty)",
        });
    });

    it("caps a long rejection message", async () => {
        const result = await runMultiPassSummary({
            rounds: 2,
            runPass: passesFrom([GOOD, new Error("x".repeat(5_000))]),
            runMerge: mergeOk,
        });
        const outcome = result.passOutcomes[1];
        if (outcome.status !== "rejected") throw new Error("expected rejected");
        expect(outcome.error.length).toBeLessThanOrEqual(200);
    });

    it("reports outcomes when the merge itself fails", async () => {
        const result = await runMultiPassSummary({
            rounds: 2,
            runPass: passesFrom([GOOD, GOOD]),
            runMerge: async () => {
                throw new Error("merge exploded");
            },
        });
        expect(result.detail).toBe("2/2 passes, merge failed -> richest pass");
        expect(result.passOutcomes).toHaveLength(2);
    });
});

describe("formatPassOutcomes", () => {
    it("renders each outcome with its index", () => {
        const outcomes: PassOutcome[] = [
            { status: "usable" },
            { status: "rejected", error: "APIError: 429" },
            { status: "unparseable", replyChars: 1832, startsWith: "{" },
        ];
        expect(formatPassOutcomes(outcomes)).toBe(
            '#1 usable; #2 rejected (APIError: 429); #3 unparseable (1832 chars, starts "{")',
        );
    });
});
