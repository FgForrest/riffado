import { describe, expect, it, vi } from "vitest";

// Queueing reaches the database and the validated env; parsing needs neither.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));

import { InvalidJobPayloadError } from "@/lib/jobs/types";
import { parseTopicsJobPayload } from "@/lib/topics/topics-job";

describe("parseTopicsJobPayload", () => {
    it("accepts a payload for either transcript source", () => {
        for (const source of ["plaud", "riffado"] as const) {
            expect(
                parseTopicsJobPayload({
                    recordingId: "rec-1",
                    source,
                    trigger: "manual",
                }),
            ).toEqual({ recordingId: "rec-1", source, trigger: "manual" });
        }
    });

    it("reads an unknown trigger as automatic", () => {
        expect(
            parseTopicsJobPayload({ recordingId: "rec-1", source: "plaud" })
                .trigger,
        ).toBe("auto");
    });

    it("rejects a missing recording or an unknown source, permanently", () => {
        for (const raw of [
            { source: "plaud" },
            { recordingId: "rec-1", source: "mixed" },
        ]) {
            expect(() => parseTopicsJobPayload(raw)).toThrow(
                InvalidJobPayloadError,
            );
        }
    });
});
