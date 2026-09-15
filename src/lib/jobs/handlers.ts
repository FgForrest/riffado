/**
 * Every job kind this deployment knows how to run.
 *
 * The one place a new kind gets wired in. Kept separate from the worker so
 * the worker stays testable without dragging in whatever a handler happens to
 * depend on -- a test for claiming and retrying should not need an OpenAI
 * client because summarisation is one of the kinds.
 */

import { summaryJobHandler } from "@/lib/summary/summary-job-handler";
import { transcriptionJobHandler } from "@/lib/transcription/transcription-job-handler";
import { videoExtractionJobHandler } from "@/lib/uploads/video-extraction-job-handler";
import { registerJobHandler } from "./registry";

/** Idempotent: safe to call from more than one entry point. */
export function registerJobHandlers(): void {
    registerJobHandler(summaryJobHandler);
    registerJobHandler(transcriptionJobHandler);
    registerJobHandler(videoExtractionJobHandler);
}
