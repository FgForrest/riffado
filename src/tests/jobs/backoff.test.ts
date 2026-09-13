/**
 * Backoff arithmetic and the retry loop built on it.
 *
 * Worth testing hard for one reason: getting this wrong is invisible. A
 * retry loop that quietly treats a permanent failure as transient costs three
 * times as much and fails anyway; one that sleeps for the wrong interval only
 * shows up under a provider outage, which is the worst moment to find out.
 */

import { describe, expect, it, vi } from "vitest";
import {
    backoffDelayMs,
    DEFAULT_BACKOFF,
    retryWithBackoff,
} from "@/lib/jobs/backoff";

/** No jitter, so the schedule is exact rather than a range. */
const exact = { baseMs: 1_000, maxMs: 30_000, jitter: 0 };

describe("backoffDelayMs", () => {
    it("doubles each attempt", () => {
        expect(backoffDelayMs(1, exact)).toBe(1_000);
        expect(backoffDelayMs(2, exact)).toBe(2_000);
        expect(backoffDelayMs(3, exact)).toBe(4_000);
        expect(backoffDelayMs(4, exact)).toBe(8_000);
    });

    it("stops at the ceiling instead of growing without bound", () => {
        expect(backoffDelayMs(6, exact)).toBe(30_000);
        expect(backoffDelayMs(50, exact)).toBe(30_000);
        // 2 ** 1000 is Infinity. The ceiling is applied to the exponential
        // before anything else, so a caller with a runaway attempt counter
        // still gets a number rather than a timer that never fires.
        expect(Number.isFinite(backoffDelayMs(1000, exact))).toBe(true);
    });

    it("treats attempt 0 and negatives as the first retry", () => {
        expect(backoffDelayMs(0, exact)).toBe(1_000);
        expect(backoffDelayMs(-5, exact)).toBe(1_000);
    });

    it("spreads jittered delays across the window below the nominal value", () => {
        const opts = { baseMs: 4_000, maxMs: 60_000, jitter: 0.5 };
        // Full jitter at 0.5 means "somewhere in [2000, 4000]" -- never
        // above, so a retry is never slower than the schedule implies.
        expect(backoffDelayMs(1, opts, () => 0)).toBe(2_000);
        expect(backoffDelayMs(1, opts, () => 1)).toBe(4_000);
        expect(backoffDelayMs(1, opts, () => 0.5)).toBe(3_000);
    });

    it("clamps a nonsensical jitter rather than inverting the delay", () => {
        expect(backoffDelayMs(1, { ...exact, jitter: 5 }, () => 0)).toBe(0);
        expect(backoffDelayMs(1, { ...exact, jitter: -3 }, () => 0)).toBe(
            1_000,
        );
    });

    it("jitters by default, because simultaneous retries recreate the burst", () => {
        // Multi-pass fires N identical requests at once, so a rate limit
        // rejects them at the same instant. Identical backoff would then have
        // them retry at the same instant too.
        const delays = new Set(
            Array.from({ length: 50 }, () =>
                backoffDelayMs(3, DEFAULT_BACKOFF),
            ),
        );
        expect(delays.size).toBeGreaterThan(1);
    });
});

describe("retryWithBackoff", () => {
    const always = () => true;
    const never = () => false;

    function recorder() {
        const slept: number[] = [];
        return {
            slept,
            sleep: async (ms: number) => {
                slept.push(ms);
            },
        };
    }

    it("returns the first success without sleeping", async () => {
        const { slept, sleep } = recorder();
        const run = vi.fn().mockResolvedValue("ok");

        await expect(
            retryWithBackoff({
                attempts: 3,
                isRetryable: always,
                run,
                sleep,
            }),
        ).resolves.toBe("ok");

        expect(run).toHaveBeenCalledTimes(1);
        expect(slept).toEqual([]);
    });

    it("retries a retryable failure and sleeps between attempts", async () => {
        const { slept, sleep } = recorder();
        const run = vi
            .fn()
            .mockRejectedValueOnce(new Error("429"))
            .mockRejectedValueOnce(new Error("429"))
            .mockResolvedValue("ok");

        await expect(
            retryWithBackoff({
                attempts: 3,
                isRetryable: always,
                run,
                sleep,
                jitter: 0,
                baseMs: 100,
                maxMs: 10_000,
            }),
        ).resolves.toBe("ok");

        expect(run).toHaveBeenCalledTimes(3);
        expect(slept).toEqual([100, 200]);
    });

    it("gives up immediately on a failure that cannot succeed later", async () => {
        const { slept, sleep } = recorder();
        const run = vi.fn().mockRejectedValue(new Error("context too long"));

        await expect(
            retryWithBackoff({
                attempts: 5,
                isRetryable: never,
                run,
                sleep,
            }),
        ).rejects.toThrow("context too long");

        // The whole point: a transcript past the context window fails the
        // same way five times, and paying for that five times is worse than
        // failing once.
        expect(run).toHaveBeenCalledTimes(1);
        expect(slept).toEqual([]);
    });

    it("stops after the configured attempts and rethrows the last error", async () => {
        const { slept, sleep } = recorder();
        const run = vi
            .fn()
            .mockRejectedValueOnce(new Error("first"))
            .mockRejectedValueOnce(new Error("second"))
            .mockRejectedValue(new Error("third"));

        await expect(
            retryWithBackoff({
                attempts: 3,
                isRetryable: always,
                run,
                sleep,
                jitter: 0,
            }),
        ).rejects.toThrow("third");

        expect(run).toHaveBeenCalledTimes(3);
        // Two sleeps, not three: nothing waits after the final attempt.
        expect(slept).toHaveLength(2);
    });

    it("runs exactly once when retrying is disabled", async () => {
        const run = vi.fn().mockRejectedValue(new Error("nope"));

        await expect(
            retryWithBackoff({ attempts: 1, isRetryable: always, run }),
        ).rejects.toThrow("nope");
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("does not start another attempt once aborted", async () => {
        const controller = new AbortController();
        const run = vi.fn().mockRejectedValue(new Error("boom"));

        controller.abort();
        await expect(
            retryWithBackoff({
                attempts: 3,
                isRetryable: always,
                run,
                signal: controller.signal,
                sleep: async () => {},
            }),
        ).rejects.toThrow("boom");

        expect(run).toHaveBeenCalledTimes(1);
    });

    it("stops if the abort lands while it is waiting", async () => {
        const controller = new AbortController();
        const run = vi.fn().mockRejectedValue(new Error("boom"));

        await expect(
            retryWithBackoff({
                attempts: 5,
                isRetryable: always,
                run,
                signal: controller.signal,
                // The worker shutting down mid-wait is the real case: another
                // provider call at that point is money spent on a result
                // nothing will read.
                sleep: async () => controller.abort(),
            }),
        ).rejects.toThrow("boom");

        expect(run).toHaveBeenCalledTimes(1);
    });

    it("reports each retry before waiting for it", async () => {
        const onRetry = vi.fn();
        const run = vi
            .fn()
            .mockRejectedValueOnce(new Error("blip"))
            .mockResolvedValue("ok");

        await retryWithBackoff({
            attempts: 2,
            isRetryable: always,
            run,
            onRetry,
            sleep: async () => {},
            jitter: 0,
            baseMs: 500,
        });

        expect(onRetry).toHaveBeenCalledWith({
            attempt: 1,
            delayMs: 500,
            error: expect.any(Error),
        });
    });
});
