import type { JobHandler } from "@/lib/jobs/types";
import { materializeFolderExport, reconcileFolderExport } from "./execution";
import {
    EXPORT_MATERIALIZE_JOB_KIND,
    EXPORT_PLAN_JOB_KIND,
    EXPORT_RECONCILE_JOB_KIND,
    type ExportMaterializePayload,
    type ExportPlanPayload,
    type ExportReconcilePayload,
    parseExportMaterializePayload,
    parseExportPlanPayload,
    parseExportReconcilePayload,
} from "./jobs";
import { planFolderExport } from "./planner";
import { isExportErrorRetryable } from "./retry";

export const exportPlanJobHandler: JobHandler<ExportPlanPayload> = {
    kind: EXPORT_PLAN_JOB_KIND,
    concurrency: 1,
    maxAttempts: 3,
    timeoutMs: 30 * 60 * 1000,
    parsePayload: parseExportPlanPayload,
    isRetryable: isExportErrorRetryable,
    async run({ userId, payload, reportProgress }) {
        reportProgress({ phase: "planning" });
        const queued = await planFolderExport(userId, payload.exportId);
        return { queued };
    },
};

export const exportMaterializeJobHandler: JobHandler<ExportMaterializePayload> =
    {
        kind: EXPORT_MATERIALIZE_JOB_KIND,
        concurrency: 2,
        maxAttempts: 5,
        timeoutMs: 60 * 60 * 1000,
        backoff: { baseMs: 10_000, maxMs: 10 * 60_000, jitter: 0.3 },
        parsePayload: parseExportMaterializePayload,
        isRetryable: isExportErrorRetryable,
        async run({ userId, payload, reportProgress }) {
            reportProgress({ phase: "materializing" });
            const exported = await materializeFolderExport(
                userId,
                payload.materializationId,
            );
            return { exported };
        },
    };

export const exportReconcileJobHandler: JobHandler<ExportReconcilePayload> = {
    kind: EXPORT_RECONCILE_JOB_KIND,
    concurrency: 1,
    maxAttempts: 3,
    timeoutMs: 60 * 60 * 1000,
    parsePayload: parseExportReconcilePayload,
    isRetryable: isExportErrorRetryable,
    async run({ userId, payload, reportProgress }) {
        reportProgress({ phase: "reconciling" });
        return reconcileFolderExport(userId, payload.folderId);
    },
};
