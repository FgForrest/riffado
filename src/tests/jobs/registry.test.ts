/**
 * The kind-to-handler map.
 *
 * Small, but it is the seam that makes "add a durable operation" a handler
 * rather than another table and another worker, so its few rules are worth
 * holding still.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
    clearJobHandlers,
    getJobHandler,
    listJobHandlers,
    registerJobHandler,
} from "@/lib/jobs/registry";
import type { JobHandler } from "@/lib/jobs/types";

function handler(kind: string, extra: Partial<JobHandler> = {}): JobHandler {
    return {
        kind,
        concurrency: 1,
        maxAttempts: 3,
        timeoutMs: 1000,
        parsePayload: (raw) => raw,
        run: async () => undefined,
        ...extra,
    } as JobHandler;
}

describe("job handler registry", () => {
    beforeEach(() => clearJobHandlers());

    it("returns a registered handler by kind", () => {
        const summary = handler("summary");
        registerJobHandler(summary);
        expect(getJobHandler("summary")).toBe(summary);
    });

    it("returns undefined for a kind nothing registered", () => {
        // A deploy that removes a handler can leave queued rows of that kind
        // behind. The worker has to cope with finding nothing rather than
        // throwing on every tick.
        expect(getJobHandler("knowledge-base")).toBeUndefined();
    });

    it("lists every handler, which is how the worker knows what to claim", () => {
        registerJobHandler(handler("summary"));
        registerJobHandler(handler("knowledge-base"));
        expect(
            listJobHandlers()
                .map((h) => h.kind)
                .sort(),
        ).toEqual(["knowledge-base", "summary"]);
    });

    it("replaces rather than throws when a kind is registered twice", () => {
        // The dev server re-evaluates modules on hot reload. Crashing at
        // startup would be a worse outcome than the last definition winning.
        registerJobHandler(handler("summary", { concurrency: 1 }));
        registerJobHandler(handler("summary", { concurrency: 4 }));
        expect(listJobHandlers()).toHaveLength(1);
        expect(getJobHandler("summary")?.concurrency).toBe(4);
    });

    it("rejects a kind too long for the column", () => {
        // Better a startup failure than rows the claim query can never match
        // because the value was silently truncated on the way in.
        expect(() => registerJobHandler(handler("k".repeat(65)))).toThrow(
            /64-character/,
        );
    });
});
