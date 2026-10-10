import { beforeEach, describe, expect, it, vi } from "vitest";

const { prunes, posthog } = vi.hoisted(() => ({
    prunes: {
        pruneAdminAuditLog: vi.fn(),
        pruneFinishedJobs: vi.fn(),
        pruneExpiredSessions: vi.fn(),
        pruneExpiredVerifications: vi.fn(),
        pruneCompletedStripeWebhookEvents: vi.fn(),
        pruneExpiredRateLimitBuckets: vi.fn(),
        pruneMcpAccessLog: vi.fn(),
        pruneMailDeliveryLog: vi.fn(),
        pruneSettledWebhookDeliveries: vi.fn(),
    },
    posthog: { captureServerException: vi.fn() },
}));

vi.mock("@/db/queries/admin", () => ({
    pruneAdminAuditLog: prunes.pruneAdminAuditLog,
}));
vi.mock("@/db/queries/async-jobs", () => ({
    pruneFinishedJobs: prunes.pruneFinishedJobs,
}));
vi.mock("@/db/queries/auth-sessions", () => ({
    pruneExpiredSessions: prunes.pruneExpiredSessions,
    pruneExpiredVerifications: prunes.pruneExpiredVerifications,
}));
vi.mock("@/db/queries/billing", () => ({
    pruneCompletedStripeWebhookEvents: prunes.pruneCompletedStripeWebhookEvents,
}));
vi.mock("@/db/queries/mail", () => ({
    MAIL_DELIVERY_LOG_RETENTION_DAYS: 30,
    pruneMailDeliveryLog: prunes.pruneMailDeliveryLog,
}));
vi.mock("@/db/queries/mcp-audit", () => ({
    pruneMcpAccessLog: prunes.pruneMcpAccessLog,
}));
vi.mock("@/db/queries/rate-limit", () => ({
    pruneExpiredRateLimitBuckets: prunes.pruneExpiredRateLimitBuckets,
}));
vi.mock("@/db/queries/webhook-deliveries", () => ({
    pruneSettledWebhookDeliveries: prunes.pruneSettledWebhookDeliveries,
}));
vi.mock("@/lib/env", () => ({ env: { MCP_AUDIT_RETENTION_DAYS: 30 } }));
vi.mock("@/lib/posthog-server", () => posthog);

import { pruneInBatches, runHousekeeping } from "@/lib/jobs/housekeeping";

const limits = { batchSize: 10, maxBatches: 5, budgetMs: 60_000 };

describe("pruneInBatches", () => {
    it("stops at the first short batch", async () => {
        const prune = vi
            .fn()
            .mockResolvedValueOnce(10)
            .mockResolvedValueOnce(10)
            .mockResolvedValueOnce(3);

        expect(await pruneInBatches(prune, limits)).toBe(23);
        expect(prune).toHaveBeenCalledTimes(3);
        expect(prune).toHaveBeenCalledWith(10);
    });

    it("stops at the batch cap", async () => {
        const prune = vi.fn().mockResolvedValue(10);

        expect(await pruneInBatches(prune, limits)).toBe(50);
        expect(prune).toHaveBeenCalledTimes(5);
    });

    it("stops once the time budget is spent", async () => {
        const prune = vi.fn().mockResolvedValue(10);

        expect(await pruneInBatches(prune, { ...limits, budgetMs: 0 })).toBe(
            10,
        );
        expect(prune).toHaveBeenCalledTimes(1);
    });
});

describe("runHousekeeping", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const prune of Object.values(prunes)) prune.mockResolvedValue(0);
    });

    it("prunes the other tables when one fails", async () => {
        prunes.pruneFinishedJobs.mockRejectedValue(new Error("db down"));
        prunes.pruneExpiredSessions.mockResolvedValue(4);
        const errorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const pruned = await runHousekeeping(limits);
        errorSpy.mockRestore();

        expect(pruned).toEqual({
            webhook_deliveries: 0,
            api_rate_limit_buckets: 0,
            stripe_webhook_events: 0,
            sessions: 4,
            verifications: 0,
            admin_audit_log: 0,
            mcp_access_log: 0,
            mail_delivery_log: 0,
        });
        expect(prunes.pruneMcpAccessLog).toHaveBeenCalledWith(30, 10);
        expect(prunes.pruneMailDeliveryLog).toHaveBeenCalledWith(30, 10);
        expect(posthog.captureServerException).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({ table: "async_jobs" }),
        );
    });
});
