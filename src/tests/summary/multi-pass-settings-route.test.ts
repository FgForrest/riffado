/**
 * `PUT /api/settings/user` for the multi-pass fields.
 *
 * The pass count is clamped on write as well as on read. Clamping on read
 * alone would leave a value the UI cannot produce sitting in the column,
 * where the next reader has to remember to defend against it; clamping here
 * means it never lands.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// `apiHandler` reaches posthog-server, which pulls the validated env and
// demands DATABASE_URL. Out of scope for a route-shape test.
vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string) => v,
    // Tagged so a test can tell an encrypted write from a raw one.
    encryptText: (v: string) => `enc(${v})`,
    decryptJsonField: <T>(v: T) => v,
    encryptJsonField: <T>(v: T) => v,
}));

const { updates, existingRow } = vi.hoisted(() => ({
    updates: [] as Record<string, unknown>[],
    existingRow: { value: [{ userId: "user-1" }] as unknown[] },
}));

vi.mock("@/db", () => {
    const selectChain = {
        from: () => selectChain,
        where: () => selectChain,
        limit: () => Promise.resolve(existingRow.value),
    };
    return {
        db: {
            select: () => selectChain,
            update: () => ({
                set: (data: Record<string, unknown>) => {
                    updates.push(data);
                    return { where: () => Promise.resolve() };
                },
            }),
            insert: () => ({
                values: (data: Record<string, unknown>) => {
                    updates.push(data);
                    return Promise.resolve();
                },
            }),
        },
    };
});

async function put(body: Record<string, unknown>) {
    const { PUT } = await import("@/app/api/settings/user/route");
    const res = await PUT(
        new Request("http://localhost/api/settings/user", {
            method: "PUT",
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
        }),
    );
    expect(res.status).toBe(200);
    return updates.at(-1) as Record<string, unknown>;
}

describe("PUT /api/settings/user — multi-pass fields", () => {
    beforeEach(() => {
        updates.length = 0;
        existingRow.value = [{ userId: "user-1" }];
    });

    it("clamps the pass count into range", async () => {
        expect(
            (await put({ summaryMultiPassRounds: 99 })).summaryMultiPassRounds,
        ).toBe(5);
        expect(
            (await put({ summaryMultiPassRounds: 1 })).summaryMultiPassRounds,
        ).toBe(2);
        expect(
            (await put({ summaryMultiPassRounds: 4 })).summaryMultiPassRounds,
        ).toBe(4);
    });

    it("stores a blank merge prompt as NULL, not an empty string", async () => {
        // One representation of "not set", so the generator's
        // `mergePrompt || DEFAULT` check has a single case to handle.
        expect(
            (await put({ summaryMergePrompt: "   " })).summaryMergePrompt,
        ).toBeNull();
        expect(
            (await put({ summaryMergePrompt: "" })).summaryMergePrompt,
        ).toBeNull();
        expect(
            (await put({ summaryMergePrompt: null })).summaryMergePrompt,
        ).toBeNull();
    });

    it("encrypts a merge prompt at rest, trimmed", async () => {
        const written = await put({ summaryMergePrompt: "  Merge my way.  " });
        expect(written.summaryMergePrompt).toBe("enc(Merge my way.)");
    });

    it("leaves the fields alone when the body omits them", async () => {
        const written = await put({ autoSummarize: true });
        expect(written).not.toHaveProperty("summaryMultiPass");
        expect(written).not.toHaveProperty("summaryMergePrompt");
    });

    it("seeds defaults when no settings row exists yet", async () => {
        existingRow.value = [];
        const written = await put({ autoSummarize: true });
        expect(written.summaryMultiPass).toBe(false);
        expect(written.summaryMultiPassRounds).toBe(3);
        expect(written.summaryMultiPassAuto).toBe(false);
        expect(written.summaryMergePrompt).toBeNull();
    });
});
