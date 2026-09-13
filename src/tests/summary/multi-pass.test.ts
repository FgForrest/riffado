/**
 * Multi-pass summarization orchestration.
 *
 * `runMultiPassSummary` takes `runPass` / `runMerge` as callbacks, so all of
 * this runs without a provider, a network or an OpenAI mock. What matters here
 * is the degradation ladder: multi-pass makes N provider calls where one used
 * to be made, so if every failure propagated it would be N times likelier to
 * fail than the single-pass path -- a worse product sold as an improvement.
 */

import { describe, expect, it, vi } from "vitest";
import {
    buildMergeInput,
    clampRounds,
    DEFAULT_MERGE_PROMPT,
    MULTI_PASS_ROUNDS_MAX,
    MULTI_PASS_ROUNDS_MIN,
    type MultiPassProgress,
    runMultiPassSummary,
} from "@/lib/summary/multi-pass";

/** A well-formed pass reply. */
function passJson(
    summary: string,
    keyPoints: string[] = [],
    actionItems: string[] = [],
) {
    return JSON.stringify({ summary, keyPoints, actionItems });
}

describe("clampRounds", () => {
    it("bounds the range and rejects nonsense", () => {
        expect(clampRounds(1)).toBe(MULTI_PASS_ROUNDS_MIN);
        expect(clampRounds(99)).toBe(MULTI_PASS_ROUNDS_MAX);
        expect(clampRounds(3)).toBe(3);
        // A settings row that predates the column, or a hand-edited value.
        expect(clampRounds(null)).toBe(MULTI_PASS_ROUNDS_MIN);
        expect(clampRounds(undefined)).toBe(3);
        expect(clampRounds("4")).toBe(4);
        expect(clampRounds(3.7)).toBe(3);
    });
});

describe("buildMergeInput", () => {
    it("labels each version so the merge prompt can refer to them", () => {
        const input = buildMergeInput([
            {
                summary: "a",
                keyPoints: ["k1"],
                actionItems: [],
                structured: true,
            },
            {
                summary: "b",
                keyPoints: [],
                actionItems: ["a1"],
                structured: true,
            },
        ]);
        expect(input).toContain("Version 1:");
        expect(input).toContain("Version 2:");
        expect(input).toContain("k1");
        expect(input).toContain("a1");
        // The internal `structured` flag is bookkeeping, not model input.
        expect(input).not.toContain("structured");
    });
});

describe("runMultiPassSummary", () => {
    it("runs every pass, then merges", async () => {
        const runPass = vi
            .fn()
            .mockResolvedValue(passJson("pass", ["k"], ["a"]));
        const runMerge = vi
            .fn()
            .mockResolvedValue(passJson("merged", ["k1", "k2"], ["a1"]));

        const result = await runMultiPassSummary({
            rounds: 3,
            runPass,
            runMerge,
        });

        expect(runPass).toHaveBeenCalledTimes(3);
        expect(runMerge).toHaveBeenCalledTimes(1);
        expect(result.merged).toBe(true);
        expect(result.passesUsed).toBe(3);
        expect(result.payload.summary).toBe("merged");
        expect(result.payload.keyPoints).toEqual(["k1", "k2"]);
    });

    it("starts the passes concurrently rather than one after another", async () => {
        let started = 0;
        let maxConcurrent = 0;
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const runPass = vi.fn(async () => {
            started += 1;
            maxConcurrent = Math.max(maxConcurrent, started);
            await gate;
            started -= 1;
            return passJson("p");
        });

        const promise = runMultiPassSummary({
            rounds: 3,
            runPass,
            runMerge: vi.fn().mockResolvedValue(passJson("merged")),
        });

        // Let the three calls reach their await before releasing them.
        await Promise.resolve();
        release?.();
        await promise;

        // Serial execution would never exceed 1. This is the whole point of
        // the feature: N passes should cost ~1 pass of wall clock.
        expect(maxConcurrent).toBe(3);
    });

    it("reports progress on real completions, then on the merge", async () => {
        const seen: MultiPassProgress[] = [];
        await runMultiPassSummary({
            rounds: 2,
            runPass: vi.fn().mockResolvedValue(passJson("p")),
            runMerge: vi.fn().mockResolvedValue(passJson("merged")),
            onProgress: (p) => seen.push({ ...p }),
        });

        expect(seen[0]).toEqual({ phase: "passes", completed: 0, total: 2 });
        expect(seen).toContainEqual({
            phase: "passes",
            completed: 1,
            total: 2,
        });
        expect(seen).toContainEqual({
            phase: "passes",
            completed: 2,
            total: 2,
        });
        expect(seen.at(-1)?.phase).toBe("merging");
    });

    it("merges the survivors when a pass fails", async () => {
        const runPass = vi
            .fn()
            .mockResolvedValueOnce(passJson("one", ["k1"]))
            .mockRejectedValueOnce(new Error("429 rate limited"))
            .mockResolvedValueOnce(passJson("three", ["k3"]));
        const runMerge = vi.fn().mockResolvedValue(passJson("merged"));

        const result = await runMultiPassSummary({
            rounds: 3,
            runPass,
            runMerge,
        });

        expect(result.passesUsed).toBe(2);
        expect(result.merged).toBe(true);
        // Only the two survivors reach the merge, renumbered 1 and 2.
        expect(runMerge.mock.calls[0][0]).toContain("Version 2:");
        expect(runMerge.mock.calls[0][0]).not.toContain("Version 3:");
    });

    it("throws only when every pass fails", async () => {
        const runPass = vi.fn().mockRejectedValue(new Error("no provider"));
        const runMerge = vi.fn();

        await expect(
            runMultiPassSummary({ rounds: 3, runPass, runMerge }),
        ).rejects.toThrow("no provider");
        expect(runMerge).not.toHaveBeenCalled();
    });

    it("skips the merge when only one pass survives", async () => {
        const runPass = vi
            .fn()
            .mockResolvedValueOnce(passJson("only", ["k"]))
            .mockRejectedValue(new Error("boom"));
        const runMerge = vi.fn();

        const result = await runMultiPassSummary({
            rounds: 3,
            runPass,
            runMerge,
        });

        // Merging one version is a re-summarization, which is exactly what
        // the merge prompt forbids -- and it would cost a call to do it.
        expect(runMerge).not.toHaveBeenCalled();
        expect(result.merged).toBe(false);
        expect(result.payload.summary).toBe("only");
    });

    it("falls back to the richest pass when the merge fails", async () => {
        const runPass = vi
            .fn()
            .mockResolvedValueOnce(passJson("thin", ["k1"]))
            .mockResolvedValueOnce(passJson("thick", ["k1", "k2"], ["a1"]));
        const runMerge = vi.fn().mockRejectedValue(new Error("timeout"));

        const result = await runMultiPassSummary({
            rounds: 2,
            runPass,
            runMerge,
        });

        expect(result.merged).toBe(false);
        expect(result.payload.summary).toBe("thick");
        expect(result.detail).toContain("merge failed");
    });

    it("falls back when the merge returns something unparseable", async () => {
        const runPass = vi
            .fn()
            .mockResolvedValue(passJson("pass", ["k1", "k2"]));
        const runMerge = vi.fn().mockResolvedValue("I'm sorry, I can't help.");

        const result = await runMultiPassSummary({
            rounds: 2,
            runPass,
            runMerge,
        });

        // A refusal is valid text and invalid JSON. Storing it would replace
        // two good summaries with an apology.
        expect(result.merged).toBe(false);
        expect(result.payload.summary).toBe("pass");
    });

    it("never merges prose", async () => {
        const runPass = vi.fn().mockResolvedValue("Here is a nice summary.");
        const runMerge = vi.fn();

        const result = await runMultiPassSummary({
            rounds: 3,
            runPass,
            runMerge,
        });

        // The merge prompt says it is receiving {summary, keyPoints,
        // actionItems} objects. Handing it paragraphs invites it to invent
        // the structure it was promised.
        expect(runMerge).not.toHaveBeenCalled();
        expect(result.passesUsed).toBe(0);
        expect(result.payload.summary).toBe("Here is a nice summary.");
    });

    it("ranks fallbacks by entry count, not by prose length", async () => {
        const runPass = vi
            .fn()
            .mockResolvedValueOnce(passJson("x".repeat(500), ["k1"]))
            .mockResolvedValueOnce(passJson("short", ["k1", "k2"], ["a1"]));
        const runMerge = vi.fn().mockRejectedValue(new Error("nope"));

        const result = await runMultiPassSummary({
            rounds: 2,
            runPass,
            runMerge,
        });

        // Ranking by raw length would reward a verbose paragraph over the
        // pass that actually extracted more.
        expect(result.payload.summary).toBe("short");
    });

    it("uses the built-in merge prompt unless the user supplied one", async () => {
        const runMerge = vi.fn().mockResolvedValue(passJson("merged"));
        const base = {
            rounds: 2,
            runPass: vi.fn().mockResolvedValue(passJson("p")),
            runMerge,
        };

        await runMultiPassSummary({ ...base, mergePrompt: "   " });
        expect(runMerge.mock.calls[0][1]).toBe(DEFAULT_MERGE_PROMPT);

        await runMultiPassSummary({ ...base, mergePrompt: "Merge my way." });
        expect(runMerge.mock.calls[1][1]).toBe("Merge my way.");
    });
});
