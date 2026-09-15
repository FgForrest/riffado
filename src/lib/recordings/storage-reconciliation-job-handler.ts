import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { rewriteExistingRecordingSidecars } from "@/lib/export/document-sidecars";
import type { JobHandler, JobResult } from "@/lib/jobs/types";
import {
    reconcileRecordingStorage,
    recordingStorageNeedsReconciliation,
} from "@/lib/recordings/reconcile-storage";
import {
    enqueueStorageReconciliationJob,
    parseStorageReconciliationJobPayload,
    parseStorageReconciliationScanPayload,
    STORAGE_RECONCILIATION_JOB_KIND,
    STORAGE_RECONCILIATION_MAX_ATTEMPTS,
    STORAGE_RECONCILIATION_SCAN_JOB_KIND,
    STORAGE_RECONCILIATION_TIMEOUT_MS,
    type StorageReconciliationJobPayload,
} from "@/lib/recordings/storage-reconciliation-job";

export const storageReconciliationScanJobHandler: JobHandler<
    Record<string, never>
> = {
    kind: STORAGE_RECONCILIATION_SCAN_JOB_KIND,
    concurrency: 2,
    maxAttempts: STORAGE_RECONCILIATION_MAX_ATTEMPTS,
    timeoutMs: STORAGE_RECONCILIATION_TIMEOUT_MS,
    parsePayload: parseStorageReconciliationScanPayload,

    async run({ userId, signal, reportProgress }): Promise<JobResult> {
        const rows = await db
            .select({
                id: recordings.id,
                filename: recordings.filename,
                storagePath: recordings.storagePath,
            })
            .from(recordings)
            .where(
                and(
                    eq(recordings.userId, userId),
                    isNull(recordings.deletedAt),
                ),
            );
        let queued = 0;

        for (let index = 0; index < rows.length; index++) {
            if (signal.aborted) throw signal.reason;
            const row = rows[index];
            const state = {
                id: row.id,
                userId,
                title: decryptText(row.filename),
                storagePath: row.storagePath,
            };
            if (recordingStorageNeedsReconciliation(state)) {
                const result = await enqueueStorageReconciliationJob({
                    userId,
                    recordingId: row.id,
                });
                if (result.created) queued++;
            }
            reportProgress({
                phase: "scanning",
                completed: index + 1,
                total: rows.length,
            });
        }

        return { checked: rows.length, queued };
    },
};

export const storageReconciliationJobHandler: JobHandler<StorageReconciliationJobPayload> =
    {
        kind: STORAGE_RECONCILIATION_JOB_KIND,
        concurrency: 2,
        maxAttempts: STORAGE_RECONCILIATION_MAX_ATTEMPTS,
        timeoutMs: STORAGE_RECONCILIATION_TIMEOUT_MS,
        parsePayload: parseStorageReconciliationJobPayload,

        async run({ userId, payload }): Promise<JobResult> {
            const [recording] = await db
                .select({
                    id: recordings.id,
                    filename: recordings.filename,
                    storagePath: recordings.storagePath,
                })
                .from(recordings)
                .where(
                    and(
                        eq(recordings.id, payload.recordingId),
                        eq(recordings.userId, userId),
                        isNull(recordings.deletedAt),
                    ),
                )
                .limit(1);
            if (!recording) return { reconciled: false };

            const result = await reconcileRecordingStorage({
                id: recording.id,
                userId,
                title: decryptText(recording.filename),
                storagePath: recording.storagePath,
            });
            await rewriteExistingRecordingSidecars(userId, recording.id);
            return { reconciled: result.changed };
        },
    };
