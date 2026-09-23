/**
 * Every job kind this deployment knows how to run.
 *
 * The one place a new kind gets wired in. Kept separate from the worker so
 * the worker stays testable without dragging in whatever a handler happens to
 * depend on -- a test for claiming and retrying should not need an OpenAI
 * client because summarisation is one of the kinds.
 */

import {
    exportMaterializeJobHandler,
    exportPlanJobHandler,
    exportReconcileJobHandler,
} from "@/lib/folder-exports/job-handlers";
import {
    storageReconciliationJobHandler,
    storageReconciliationScanJobHandler,
} from "@/lib/recordings/storage-reconciliation-job-handler";
import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import { topicsJobHandler } from "@/lib/topics/topics-job-handler";
import { transcriptionJobHandler } from "@/lib/transcription/transcription-job-handler";
import { videoExtractionJobHandler } from "@/lib/uploads/video-extraction-job-handler";
import { registerJobHandler } from "./registry";

/** Idempotent: safe to call from more than one entry point. */
export function registerJobHandlers(): void {
    registerJobHandler(summaryJobHandler);
    registerJobHandler(topicsJobHandler);
    registerJobHandler(transcriptionJobHandler);
    registerJobHandler(videoExtractionJobHandler);
    registerJobHandler(storageReconciliationScanJobHandler);
    registerJobHandler(storageReconciliationJobHandler);
    registerJobHandler(exportPlanJobHandler);
    registerJobHandler(exportMaterializeJobHandler);
    registerJobHandler(exportReconcileJobHandler);
}
