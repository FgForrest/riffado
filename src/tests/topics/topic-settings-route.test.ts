/**
 * `PUT /api/settings/user` for the topic fields: the switch is stored as
 * sent, and the template list is validated against the topic built-ins and
 * encrypted before it lands.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTopicPromptConfig } from "@/lib/topics/topic-presets";

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string) => v,
    encryptText: (v: string) => `enc(${v})`,
    decryptJsonField: <T>(v: T) => v,
    // Tagged so a test can tell an encrypted write from a raw one.
    encryptJsonField: <T>(v: T) => ({ encrypted: v }),
}));

const { updates } = vi.hoisted(() => ({
    updates: [] as Record<string, unknown>[],
}));

vi.mock("@/db", () => {
    const selectChain = {
        from: () => selectChain,
        where: () => selectChain,
        limit: () => Promise.resolve([{ userId: "user-1" }]),
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
        },
    };
});

async function put(body: Record<string, unknown>) {
    const { PUT } = await import("@/app/api/settings/user/route");
    return PUT(
        new Request("http://localhost/api/settings/user", {
            method: "PUT",
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
        }),
    );
}

describe("PUT /api/settings/user — topic fields", () => {
    beforeEach(() => {
        updates.length = 0;
    });

    it("stores the auto-detect switch", async () => {
        const res = await put({ autoDetectTopics: true });
        expect(res.status).toBe(200);
        expect(updates.at(-1)).toHaveProperty("autoDetectTopics", true);
    });

    it("encrypts a valid topic template list", async () => {
        const config = normalizeTopicPromptConfig(null);
        const res = await put({ topicPrompt: config });
        expect(res.status).toBe(200);
        expect(updates.at(-1)?.topicPrompt).toEqual({ encrypted: config });
    });

    it("rejects a list whose unedited built-in is not a topic built-in", async () => {
        const res = await put({
            topicPrompt: {
                selectedPrompt: "general",
                templates: [
                    {
                        id: "general",
                        name: null,
                        prompt: null,
                        createdAt: new Date(0).toISOString(),
                    },
                ],
            },
        });
        expect(res.status).toBe(400);
        expect(updates).toHaveLength(0);
    });
});
