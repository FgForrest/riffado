import { isNull } from "drizzle-orm";
import { db } from "@/db";
import { type EnqueueJobResult, enqueueJob } from "@/db/queries/async-jobs";
import { recordings } from "@/db/schema";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";
import { captureServerException } from "@/lib/posthog-server";

export const STORAGE_RECONCILIATION_SCAN_JOB_KIND =
    "recording-storage-reconciliation-scan";
export const STORAGE_RECONCILIATION_JOB_KIND =
    "recording-storage-reconciliation";
export const STORAGE_RECONCILIATION_MAX_ATTEMPTS = 3;
export const STORAGE_RECONCILIATION_TIMEOUT_MS = 10 * 60 * 1000;

export interface StorageReconciliationJobPayload {
    recordingId: string;
}

/** Validate a persisted per-recording reconciliation payload. */
export function parseStorageReconciliationJobPayload(
    raw: Record<string, unknown>,
): StorageReconciliationJobPayload {
    if (typeof raw.recordingId !== "string" || raw.recordingId.length === 0) {
        throw new InvalidJobPayloadError(
            STORAGE_RECONCILIATION_JOB_KIND,
            "recordingId must be a non-empty string",
        );
    }
    return { recordingId: raw.recordingId };
}

/** The scan carries no user content; ownership comes from the job row. */
export function parseStorageReconciliationScanPayload(): Record<string, never> {
    return {};
}

export async function enqueueStorageReconciliationJob(input: {
    userId: string;
    recordingId: string;
}): Promise<EnqueueJobResult> {
    const enqueued = await enqueueJob({
        userId: input.userId,
        kind: STORAGE_RECONCILIATION_JOB_KIND,
        subjectId: input.recordingId,
        maxAttempts: STORAGE_RECONCILIATION_MAX_ATTEMPTS,
        payload: { recordingId: input.recordingId },
    });
    if (enqueued.created) nudge();
    return enqueued;
}

export async function enqueueStorageReconciliationScan(
    userId: string,
): Promise<EnqueueJobResult> {
    const enqueued = await enqueueJob({
        userId,
        kind: STORAGE_RECONCILIATION_SCAN_JOB_KIND,
        subjectId: userId,
        maxAttempts: STORAGE_RECONCILIATION_MAX_ATTEMPTS,
        payload: {},
    });
    if (enqueued.created) nudge();
    return enqueued;
}

/** Seed one durable, user-scoped scan per owner after every application boot. */
export async function seedStorageReconciliationJobs(): Promise<number> {
    const owners = await db
        .selectDistinct({ userId: recordings.userId })
        .from(recordings)
        .where(isNull(recordings.deletedAt));
    let queued = 0;
    for (const { userId } of owners) {
        const result = await enqueueStorageReconciliationScan(userId);
        if (result.created) queued++;
    }
    return queued;
}

let started = false;

/** Start the one-shot boot seeder. Safe to call more than once per process. */
export function startStorageReconciliationSeeder(): void {
    if (started) return;
    started = true;
    void seedStorageReconciliationJobs()
        .then((queued) => {
            if (queued > 0) {
                console.log(
                    `[storage-reconciliation] queued ${queued} user scan(s)`,
                );
            }
        })
        .catch((error) => {
            console.error(
                "[storage-reconciliation] failed to seed startup scans:",
                error,
            );
            captureServerException(error, {
                source: "worker:storage-reconciliation-seeder",
            });
        });
}

/** Test seam. */
export function __resetStorageReconciliationSeederForTests(): void {
    started = false;
}
