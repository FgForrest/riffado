/**
 * Which failures get another attempt, and what a failed job is allowed to say.
 *
 * The classification is an allowlist, and these tests exist to keep it one.
 * A permissive default would mean every new error code in the app silently
 * starts costing three provider calls instead of one -- and would do it
 * without anybody choosing to.
 */

import { APIError } from "openai";
import { describe, expect, it, vi } from "vitest";

// `errors.ts` pulls in PostHog for server-side capture, which reads the
// validated env. Nothing here exercises capture.
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

import { AppError, ErrorCode } from "@/lib/errors";
import {
    appErrorFromJobFailure,
    describeJobError,
    isRetryableError,
    JobAbortedError,
    JobTimeoutError,
} from "@/lib/jobs/retryable";

/** An OpenAI-shaped error at a given status, as a provider would raise it. */
function providerError(status: number, message = "provider said no") {
    return new APIError(status, { message }, undefined, undefined);
}

describe("isRetryableError", () => {
    it("retries a rate limit", () => {
        expect(isRetryableError(providerError(429))).toBe(true);
        expect(
            isRetryableError(
                new AppError(ErrorCode.AI_RATE_LIMITED, "slow down", 429),
            ),
        ).toBe(true);
    });

    it("retries a provider outage and a transport failure", () => {
        expect(isRetryableError(providerError(503))).toBe(true);
        expect(
            isRetryableError(
                new AppError(ErrorCode.UPSTREAM_BAD_RESPONSE, "down", 502),
            ),
        ).toBe(true);
    });

    it("does not retry a transcript past the context window", () => {
        // Three attempts produce three identical failures, more slowly and at
        // three times the cost.
        expect(
            isRetryableError(
                new AppError(
                    ErrorCode.AI_CONTEXT_LENGTH_EXCEEDED,
                    "too long",
                    400,
                ),
            ),
        ).toBe(false);
    });

    it("does not retry a missing provider or a deleted recording", () => {
        expect(
            isRetryableError(
                new AppError(ErrorCode.AI_PROVIDER_NOT_CONFIGURED, "none", 400),
            ),
        ).toBe(false);
        expect(
            isRetryableError(
                new AppError(ErrorCode.RECORDING_NOT_FOUND, "gone", 404),
            ),
        ).toBe(false);
    });

    it("does not retry a generic provider rejection", () => {
        // A 400 from the provider means the request was wrong, and it will be
        // just as wrong next time.
        expect(isRetryableError(providerError(400))).toBe(false);
    });

    it("retries a timeout", () => {
        // Usually a provider that stopped answering rather than work that is
        // inherently too slow -- and a job that really is too slow still runs
        // out of attempts.
        expect(isRetryableError(new JobTimeoutError("summary", 1000))).toBe(
            true,
        );
    });

    it("does not retry an abort", () => {
        // The worker is shutting down or the claim was taken over. Something
        // else has already decided what happens next.
        expect(isRetryableError(new JobAbortedError())).toBe(false);
    });

    it("retries an unclassified error, which is where transport failures land", () => {
        // `fetch failed` has no status and no type, and maps to
        // INTERNAL_ERROR. Treating that as permanent would mean the single
        // most common transient failure silently loses unattended work.
        expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    });

    it("does not retry a bad payload", () => {
        expect(
            isRetryableError(
                new AppError(ErrorCode.INVALID_INPUT, "no transcript", 400),
            ),
        ).toBe(false);
    });
});

describe("describeJobError", () => {
    it("stores the mapped message, never the provider's own", () => {
        const raw =
            "Incorrect API key provided: sk-abc***. Request id req_12345";
        const { message, code } = describeJobError(providerError(401, raw));

        // The job row is read back by the browser. An upstream error message
        // can carry request details or key fragments, so it must not be what
        // gets persisted -- the unredacted error goes to the console and
        // PostHog instead.
        expect(message).not.toContain("sk-abc");
        expect(message).not.toContain("req_12345");
        expect(code).toBe(ErrorCode.AI_PROVIDER_API_ERROR);
    });

    it("keeps an AppError's own message, which is already user-facing", () => {
        expect(
            describeJobError(
                new AppError(
                    ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
                    "No AI provider configured",
                    400,
                ),
            ),
        ).toEqual({
            message: "No AI provider configured",
            code: ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
        });
    });
});

describe("appErrorFromJobFailure", () => {
    it("gives a configuration failure a 4xx rather than a server error", () => {
        const error = appErrorFromJobFailure(
            "AI_PROVIDER_NOT_CONFIGURED",
            "No AI provider configured",
        );
        expect(error.statusCode).toBe(400);
        expect(error.message).toBe("No AI provider configured");
    });

    it("maps a rate limit to 429 and an outage to 502", () => {
        expect(appErrorFromJobFailure("AI_RATE_LIMITED", "x").statusCode).toBe(
            429,
        );
        expect(
            appErrorFromJobFailure("UPSTREAM_BAD_RESPONSE", "x").statusCode,
        ).toBe(502);
    });

    it("falls back to 500 for a code it does not recognise", () => {
        const error = appErrorFromJobFailure("SOMETHING_NEW", "x");
        expect(error.statusCode).toBe(500);
        expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    });

    it("survives a row with no error recorded at all", () => {
        const error = appErrorFromJobFailure(null, null);
        expect(error.statusCode).toBe(500);
        expect(error.message).toBe("The job failed");
    });
});
