import { AppError, ErrorCode } from "@/lib/errors";
import { isMailEnabled } from "@/lib/mail/config";

/** Mail routes do not exist on an instance without mail. */
export function requireMailEnabled(): void {
    if (!isMailEnabled()) {
        throw new AppError(ErrorCode.NOT_FOUND, "Not found", 404);
    }
}
