import {
    GoogleApiError,
    GoogleConnectionUnavailableError,
} from "@/lib/integrations/google/errors";
import { isRetryableError } from "@/lib/jobs/retryable";
import { DriveTargetLostError } from "./drive-provider";

/**
 * Export jobs retry transient failures only. A missing or revoked Google
 * account and a lost Drive folder wait for the user: reconnecting or
 * editing the export plans it again.
 */
export function isExportErrorRetryable(error: unknown): boolean {
    if (
        error instanceof GoogleConnectionUnavailableError ||
        error instanceof DriveTargetLostError
    ) {
        return false;
    }
    if (error instanceof GoogleApiError) {
        return error.retryable || error.status === 401;
    }
    return isRetryableError(error);
}
