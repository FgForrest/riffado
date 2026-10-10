import { pruneAdminAuditLog } from "@/db/queries/admin";
import { pruneFinishedJobs } from "@/db/queries/async-jobs";
import {
    pruneExpiredSessions,
    pruneExpiredVerifications,
} from "@/db/queries/auth-sessions";
import { pruneCompletedStripeWebhookEvents } from "@/db/queries/billing";
import {
    MAIL_DELIVERY_LOG_RETENTION_DAYS,
    pruneMailDeliveryLog,
} from "@/db/queries/mail";
import { pruneMcpAccessLog } from "@/db/queries/mcp-audit";
import { pruneExpiredRateLimitBuckets } from "@/db/queries/rate-limit";
import { pruneSettledWebhookDeliveries } from "@/db/queries/webhook-deliveries";
import { env } from "@/lib/env";
import { captureServerException } from "@/lib/posthog-server";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bounds on one table's prune within a single housekeeping run. */
export interface PruneLimits {
    batchSize: number;
    maxBatches: number;
    budgetMs: number;
}

const DEFAULT_PRUNE_LIMITS: PruneLimits = {
    batchSize: 1_000,
    maxBatches: 100,
    budgetMs: 10_000,
};

/**
 * Run `prune(limit)` until a batch deletes fewer than `batchSize` rows, or
 * `maxBatches` ran, or `budgetMs` passed. Each batch is its own statement,
 * so no long transaction or lock is held. Returns the rows deleted.
 */
export async function pruneInBatches(
    prune: (limit: number) => Promise<number>,
    limits: PruneLimits = DEFAULT_PRUNE_LIMITS,
): Promise<number> {
    const deadline = Date.now() + limits.budgetMs;
    let total = 0;
    for (let batch = 0; batch < limits.maxBatches; batch++) {
        const deleted = await prune(limits.batchSize);
        total += deleted;
        if (deleted < limits.batchSize || Date.now() >= deadline) break;
    }
    return total;
}

/**
 * Delete expired bookkeeping rows: finished jobs after a day, settled
 * webhook deliveries after 30 days, closed rate-limit windows after a day,
 * completed Stripe events after 90 days, expired sessions after a day,
 * expired verification values, admin read-audit rows after 90 days, and
 * MCP access-log rows after MCP_AUDIT_RETENTION_DAYS.
 *
 * Each table is pruned on its own, so one failing does not stop the rest.
 * Safe to run in several processes at once. Returns the rows deleted per
 * table.
 */
export async function runHousekeeping(
    limits: PruneLimits = DEFAULT_PRUNE_LIMITS,
): Promise<Record<string, number>> {
    const now = Date.now();
    const prunes: [string, (limit: number) => Promise<number>][] = [
        ["async_jobs", (limit) => pruneFinishedJobs(DAY_MS, limit)],
        [
            "webhook_deliveries",
            (limit) =>
                pruneSettledWebhookDeliveries(
                    new Date(now - 30 * DAY_MS),
                    limit,
                ),
        ],
        [
            "api_rate_limit_buckets",
            (limit) =>
                pruneExpiredRateLimitBuckets(new Date(now - DAY_MS), limit),
        ],
        [
            "stripe_webhook_events",
            (limit) =>
                pruneCompletedStripeWebhookEvents(
                    new Date(now - 90 * DAY_MS),
                    limit,
                ),
        ],
        [
            "sessions",
            (limit) => pruneExpiredSessions(new Date(now - DAY_MS), limit),
        ],
        [
            "verifications",
            (limit) => pruneExpiredVerifications(new Date(now), limit),
        ],
        ["admin_audit_log", (limit) => pruneAdminAuditLog(limit, 90)],
        [
            "mcp_access_log",
            (limit) => pruneMcpAccessLog(env.MCP_AUDIT_RETENTION_DAYS, limit),
        ],
        [
            "mail_delivery_log",
            (limit) =>
                pruneMailDeliveryLog(MAIL_DELIVERY_LOG_RETENTION_DAYS, limit),
        ],
    ];

    const pruned: Record<string, number> = {};
    for (const [table, prune] of prunes) {
        try {
            pruned[table] = await pruneInBatches(prune, limits);
        } catch (error) {
            console.error(`[housekeeping] pruning ${table} failed:`, error);
            captureServerException(error, {
                source: "worker:housekeeping",
                table,
            });
        }
    }
    return pruned;
}
