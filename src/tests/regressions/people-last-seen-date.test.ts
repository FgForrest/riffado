import { max } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatterItems } from "@/db/schema";

describe("People last-seen aggregate", () => {
    it("uses the timestamp column decoder before Server Component serialization", () => {
        const expression = max(chatterItems.occurredAt);
        const { decoder } = expression as unknown as {
            decoder: { mapFromDriverValue: (value: unknown) => unknown };
        };
        const decoded = decoder.mapFromDriverValue("2026-09-15 20:15:00");

        expect(decoded).toBeInstanceOf(Date);
        if (!(decoded instanceof Date)) throw new Error("Expected a Date");
        expect(decoded.toISOString()).toBe("2026-09-15T20:15:00.000Z");
    });
});
