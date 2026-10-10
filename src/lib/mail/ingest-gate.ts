import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { deniedOnAdminHost } from "@/lib/hosted/hostname-gate";
import { isMailEnabled } from "@/lib/mail/config";
import { consumeRateLimitBucket, getClientIp } from "@/lib/rate-limit";

const BEARER = /^bearer\s+(\S+)\s*$/i;
/** Failed bearer checks allowed per client per window. */
const FAILURE_LIMIT = 20;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

function presentedSecretMatches(request: Request): boolean {
    const presented = BEARER.exec(
        request.headers.get("authorization") ?? "",
    )?.[1];
    const expected = env.MAIL_INGEST_SECRET;
    if (!presented || !expected) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    // Length first: timingSafeEqual throws on a mismatch, and the secret's
    // length is no secret.
    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The gate of `/api/internal/mail/*`, for the mail receiver alone: 404
 * while mail is off or on the admin host, 401 without the ingest secret,
 * 429 after repeated failures. Null when the request may proceed.
 */
export async function mailIngestGate(
    request: Request,
): Promise<Response | null> {
    if (!isMailEnabled() || deniedOnAdminHost(request, env.ADMIN_HOSTNAME)) {
        return new Response(null, { status: 404 });
    }
    if (presentedSecretMatches(request)) return null;
    const limited = await consumeRateLimitBucket(
        `mail-ingest-failure:${getClientIp(request)}`,
        { limit: FAILURE_LIMIT, windowMs: FAILURE_WINDOW_MS },
    );
    return new Response(null, { status: limited.allowed ? 401 : 429 });
}
