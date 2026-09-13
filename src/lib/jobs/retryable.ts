/**
 * Which failures are worth trying again.
 *
 * Retrying is not free: one summary job is N provider calls, so a job retried
 * three times for a reason that could never have succeeded spends 3N calls to
 * arrive at the same failure, more slowly. The classification below is
 * therefore an ALLOWLIST -- anything not named is treated as permanent.
 *
 * That direction is deliberate. A new error code added elsewhere in the app
 * should not silently start costing three times as much; it should fail
 * cleanly and visibly until somebody decides it is transient.
 */

import { AppError, ErrorCode, mapErrorToAppError } from "@/lib/errors";
import { InvalidJobPayloadError } from "./types";

/** An attempt that ran past its handler's ceiling. */
export class JobTimeoutError extends Error {
    constructor(kind: string, timeoutMs: number) {
        super(`Job of kind "${kind}" exceeded its ${timeoutMs}ms time limit`);
        this.name = "JobTimeoutError";
    }
}

/** Raised when the worker is asked to stop while a handler is running. */
export class JobAbortedError extends Error {
    constructor(message = "Job aborted") {
        super(message);
        this.name = "JobAbortedError";
    }
}

/**
 * Error codes that describe a condition which may simply not be true any
 * more in thirty seconds.
 */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
    // The provider asked us to slow down. Waiting is the entire remedy.
    ErrorCode.AI_RATE_LIMITED,
    ErrorCode.RATE_LIMITED,
    ErrorCode.PLAUD_RATE_LIMITED,
    // A provider 5xx, or no HTTP response at all -- DNS, TLS, a timeout, an
    // agent bridge that is restarting. The request never got a verdict.
    ErrorCode.UPSTREAM_BAD_RESPONSE,
    ErrorCode.PLAUD_UPSTREAM_ERROR,
    ErrorCode.SERVICE_UNAVAILABLE,
    // Transient infrastructure: a storage blip, an SMTP hiccup.
    ErrorCode.STORAGE_ERROR,
    ErrorCode.EMAIL_SEND_FAILED,
    // The catch-all `mapErrorToAppError` falls through to, which is also
    // where an un-typed transport failure ("fetch failed") lands. Including
    // it means a real bug in a handler is paid for up to `maxAttempts`
    // times -- accepted, because the alternative is that the single most
    // common transient failure permanently loses unattended work, and a
    // recording that silently never gets summarised is the exact outcome
    // this queue exists to prevent.
    ErrorCode.INTERNAL_ERROR,
]);

/**
 * True when `error` is worth another attempt.
 *
 * A timeout counts: the usual cause is a provider that stopped responding
 * rather than a job that is inherently too slow, and a job that really is too
 * slow still stops after `maxAttempts` instead of running forever.
 *
 * An abort does not: the worker is shutting down or the job was superseded,
 * and in both cases something else already decided what happens next.
 */
export function isRetryableError(error: unknown): boolean {
    if (error instanceof JobAbortedError) return false;
    // A payload that does not parse now will not parse in thirty seconds.
    // Named explicitly because it would otherwise fall through to the
    // unclassified case below and be retried as though it were a network
    // blip -- and a row written by a different deploy would then be attempted
    // three times instead of failing once, clearly.
    if (error instanceof InvalidJobPayloadError) return false;
    if (error instanceof JobTimeoutError) return true;
    const mapped =
        error instanceof AppError ? error : mapErrorToAppError(error);
    return RETRYABLE_CODES.has(mapped.code);
}

/**
 * A user-safe message and code for a failure, for storage on the job row.
 *
 * Always the MAPPED message, never `error.message`: a raw provider error can
 * carry upstream request details or key fragments, and this row is read back
 * by the browser. The unredacted error still reaches the console and PostHog,
 * where it belongs.
 */
export function describeJobError(error: unknown): {
    message: string;
    code: ErrorCode;
} {
    const mapped =
        error instanceof AppError ? error : mapErrorToAppError(error);
    return { message: mapped.message, code: mapped.code };
}

/**
 * HTTP statuses for the codes a failed job can carry.
 *
 * A job row stores a code and a message but not a status -- the failure
 * happened on a worker, where there was no response to give it one. A route
 * reporting that failure to a caller has to supply it, and this is the map
 * that does, defaulting to 500 for anything not listed.
 *
 * Only codes that jobs actually produce are named. The point is a faithful
 * answer for the handful of failures a user will really see -- "no provider
 * configured" reading as a 400 rather than a server error -- not a second
 * copy of `mapErrorToAppError`'s table.
 */
const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
    [ErrorCode.RECORDING_NOT_FOUND]: 404,
    [ErrorCode.NOT_FOUND]: 404,
    [ErrorCode.INVALID_INPUT]: 400,
    [ErrorCode.AI_PROVIDER_NOT_CONFIGURED]: 400,
    [ErrorCode.AI_PROVIDER_API_ERROR]: 400,
    [ErrorCode.AI_CONTEXT_LENGTH_EXCEEDED]: 400,
    [ErrorCode.AI_RATE_LIMITED]: 429,
    [ErrorCode.RATE_LIMITED]: 429,
    [ErrorCode.MYNAH_BUDGET_EXHAUSTED]: 402,
    [ErrorCode.UPSTREAM_BAD_RESPONSE]: 502,
    [ErrorCode.SERVICE_UNAVAILABLE]: 503,
};

/** Rebuild a throwable error from what a failed job row recorded. */
export function appErrorFromJobFailure(
    code: string | null | undefined,
    message: string | null | undefined,
): AppError {
    const known = (Object.values(ErrorCode) as string[]).includes(code ?? "")
        ? (code as ErrorCode)
        : ErrorCode.INTERNAL_ERROR;
    return new AppError(
        known,
        message || "The job failed",
        STATUS_BY_CODE[known] ?? 500,
    );
}
