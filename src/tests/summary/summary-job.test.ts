/**
 * Queueing a summary, and validating what comes back off the row.
 *
 * The payload parser is the boundary between a row written by one deploy and
 * handler code from another, so it is checked for what it rejects as much as
 * for what it accepts. The priority is the other thing worth pinning: without
 * it, a user who clicks "Generate summary" during a sync waits behind every
 * recording that sync decided to summarise.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/db/queries/async-jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));

import { enqueueJob } from "@/db/queries/async-jobs";
import { nudge } from "@/lib/jobs/nudge";
import { InvalidJobPayloadError } from "@/lib/jobs/types";
import {
    enqueueSummaryJob,
    parseSummaryJobPayload,
    SUMMARY_JOB_KIND,
    SUMMARY_MAX_ATTEMPTS,
    SUMMARY_PRIORITY_AUTO,
    SUMMARY_PRIORITY_MANUAL,
} from "@/lib/summary/summary-job";

describe("parseSummaryJobPayload", () => {
    it("accepts a well-formed payload", () => {
        expect(
            parseSummaryJobPayload({
                recordingId: "rec-1",
                presetId: "meeting-notes",
                trigger: "manual",
            }),
        ).toEqual({
            recordingId: "rec-1",
            presetId: "meeting-notes",
            trigger: "manual",
        });
    });

    it("rejects a payload with no recording to summarise", () => {
        // Permanent by the worker's rules, which is right: there is nothing
        // to retry towards.
        expect(() => parseSummaryJobPayload({})).toThrow(
            InvalidJobPayloadError,
        );
        expect(() => parseSummaryJobPayload({ recordingId: "" })).toThrow(
            InvalidJobPayloadError,
        );
        expect(() => parseSummaryJobPayload({ recordingId: 7 })).toThrow(
            InvalidJobPayloadError,
        );
    });

    it("rejects a preset that is not a string", () => {
        expect(() =>
            parseSummaryJobPayload({ recordingId: "rec-1", presetId: 12 }),
        ).toThrow(InvalidJobPayloadError);
    });

    it("reads an unknown trigger as automatic", () => {
        // The trigger selects analytics labelling and the multi-pass auto
        // opt-in. The conservative reading of a value we do not recognise is
        // the one that does not spend extra passes.
        expect(parseSummaryJobPayload({ recordingId: "rec-1" }).trigger).toBe(
            "auto",
        );
        expect(
            parseSummaryJobPayload({ recordingId: "rec-1", trigger: "weird" })
                .trigger,
        ).toBe("auto");
    });

    it("round-trips what enqueueSummaryJob writes", async () => {
        // The two halves of the contract live in different modules and are
        // easy to drift apart; this is the only place they meet.
        (enqueueJob as Mock).mockResolvedValue({
            job: { id: "job-1" },
            created: true,
        });
        await enqueueSummaryJob({
            userId: "user-1",
            recordingId: "rec-1",
            presetId: "meeting-notes",
            trigger: "manual",
        });
        const written = (enqueueJob as Mock).mock.calls[0][0].payload;

        expect(parseSummaryJobPayload(written)).toEqual({
            recordingId: "rec-1",
            presetId: "meeting-notes",
            trigger: "manual",
        });
    });
});

describe("enqueueSummaryJob", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (enqueueJob as Mock).mockResolvedValue({
            job: { id: "job-1" },
            created: true,
        });
    });

    it("queues under the recording, so two clicks buy one summary", async () => {
        await enqueueSummaryJob({
            userId: "user-1",
            recordingId: "rec-1",
            trigger: "manual",
        });

        // `subjectId` is what the partial unique index dedupes on.
        expect(enqueueJob).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: SUMMARY_JOB_KIND,
                subjectId: "rec-1",
                userId: "user-1",
                maxAttempts: SUMMARY_MAX_ATTEMPTS,
            }),
        );
    });

    it("ranks a summary someone asked for above one a sync started", async () => {
        await enqueueSummaryJob({
            userId: "u",
            recordingId: "rec-1",
            trigger: "manual",
        });
        await enqueueSummaryJob({
            userId: "u",
            recordingId: "rec-2",
            trigger: "auto",
        });

        expect((enqueueJob as Mock).mock.calls[0][0].priority).toBe(
            SUMMARY_PRIORITY_MANUAL,
        );
        expect((enqueueJob as Mock).mock.calls[1][0].priority).toBe(
            SUMMARY_PRIORITY_AUTO,
        );
        expect(SUMMARY_PRIORITY_MANUAL).toBeGreaterThan(SUMMARY_PRIORITY_AUTO);
    });

    it("omits presetId entirely rather than storing an undefined", async () => {
        await enqueueSummaryJob({
            userId: "u",
            recordingId: "rec-1",
            trigger: "auto",
        });

        expect(
            "presetId" in (enqueueJob as Mock).mock.calls[0][0].payload,
        ).toBe(false);
    });

    it("wakes the local worker for a job it actually created", async () => {
        await enqueueSummaryJob({
            userId: "u",
            recordingId: "rec-1",
            trigger: "manual",
        });
        expect(nudge).toHaveBeenCalledTimes(1);
    });

    it("does not wake the worker when the job was already queued", async () => {
        // Nothing new to run -- the existing job is either queued or already
        // being worked on, and a sweep would find nothing.
        (enqueueJob as Mock).mockResolvedValue({
            job: { id: "job-1" },
            created: false,
        });

        const result = await enqueueSummaryJob({
            userId: "u",
            recordingId: "rec-1",
            trigger: "manual",
        });

        expect(nudge).not.toHaveBeenCalled();
        expect(result.created).toBe(false);
    });
});
