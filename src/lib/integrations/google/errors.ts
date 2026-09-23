export type GoogleConnectionProblem =
    | "not_configured"
    | "not_connected"
    | "needs_reconnect"
    | "account_mismatch";

const PROBLEM_MESSAGES: Record<GoogleConnectionProblem, string> = {
    not_configured: "The Google integration is not configured",
    not_connected: "No Google account is connected",
    needs_reconnect: "The Google account must be reconnected",
    account_mismatch:
        "The export was set up with a different Google account than the one connected",
};

/**
 * Raised when there is no usable Google connection. Never worth a retry:
 * only the user can fix it, and reconnecting re-queues the work.
 */
export class GoogleConnectionUnavailableError extends Error {
    readonly problem: GoogleConnectionProblem;

    constructor(problem: GoogleConnectionProblem) {
        super(PROBLEM_MESSAGES[problem]);
        this.name = "GoogleConnectionUnavailableError";
        this.problem = problem;
    }
}

/** A Google endpoint answered with an error. */
export class GoogleApiError extends Error {
    readonly status: number;
    /** Google's own reason (`rateLimitExceeded`, `invalid_grant`, ...). */
    readonly reason: string | null;

    constructor(status: number, reason: string | null, message: string) {
        super(message);
        this.name = "GoogleApiError";
        this.status = status;
        this.reason = reason;
    }

    /** Throttling and server errors pass; anything else will fail again. */
    get retryable(): boolean {
        if (this.status === 429 || this.status >= 500) return true;
        return (
            this.status === 403 &&
            (this.reason === "rateLimitExceeded" ||
                this.reason === "userRateLimitExceeded")
        );
    }
}
