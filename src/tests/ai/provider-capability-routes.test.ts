import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false },
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

vi.mock("@/lib/encryption", () => ({
    encrypt: vi.fn((plaintext: string) => `encrypted:${plaintext}`),
    decrypt: vi.fn((ciphertext: string) =>
        ciphertext.replace(/^encrypted:/, ""),
    ),
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

vi.mock("@/db", () => ({
    db: { select: vi.fn(), transaction: vi.fn() },
}));

vi.mock("@/lib/ai/list-providers", () => ({
    listUserProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/ai/set-default-transcription", () => ({
    setDefaultTranscriptionProvider: vi.fn().mockResolvedValue(undefined),
}));

// Pulled in transitively by `included-provider`; both reach the DB.
vi.mock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn().mockResolvedValue({ monthlyMynahSeconds: 0 }),
}));

vi.mock("@/lib/hosted/transcription/mynah", () => ({
    isMynahConfigured: vi.fn().mockReturnValue(false),
}));

import { PUT as updateProvider } from "@/app/api/settings/ai/providers/[id]/route";
import { PUT as setDefaultTranscription } from "@/app/api/settings/ai/providers/default-transcription/route";
import { POST as addProvider } from "@/app/api/settings/ai/providers/route";
import { db } from "@/db";
import { setDefaultTranscriptionProvider } from "@/lib/ai/set-default-transcription";

/** One `db.select()...limit(1)` result. */
function queueSelect(rows: unknown[]) {
    (db.select as Mock).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(rows),
            }),
        }),
    });
}

function jsonRequest(body: Record<string, unknown>, method = "POST") {
    return new Request("https://app.example.com/api/settings/ai/providers", {
        method,
        body: JSON.stringify(body),
    });
}

function idParams(id = "cred-1") {
    return { params: Promise.resolve({ id }) };
}

/**
 * An enhancement-only provider (the agent CLIs behind the bridge sidecar)
 * speaks `chat/completions` but takes no audio, so pointing transcription
 * at one produces a run that cannot succeed. Three write paths can aim
 * transcription at a credential; `transcribeRecording` itself resolves
 * only what those three wrote, so these are the complete set of guards.
 */
describe("enhancement-only providers cannot become the transcription default", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (db.transaction as Mock).mockImplementation(
            async (fn: (tx: unknown) => Promise<unknown>) =>
                fn({
                    update: () => ({
                        set: () => ({
                            where: vi.fn().mockResolvedValue(undefined),
                        }),
                    }),
                    insert: () => ({
                        values: () => ({
                            returning: vi
                                .fn()
                                .mockResolvedValue([{ id: "cred-1" }]),
                        }),
                    }),
                }),
        );
    });

    describe("POST /api/settings/ai/providers", () => {
        it("rejects Claude Code as the transcription default", async () => {
            const response = await addProvider(
                jsonRequest({
                    provider: "Claude Code",
                    apiKey: "bridge-token",
                    isDefaultTranscription: true,
                }),
            );
            const body = await response.json();

            expect(response.status).toBe(400);
            expect(body.details).toEqual({ field: "isDefaultTranscription" });
            expect(db.transaction).not.toHaveBeenCalled();
        });

        it("accepts Claude Code as the enhancement default", async () => {
            const response = await addProvider(
                jsonRequest({
                    provider: "Claude Code",
                    apiKey: "bridge-token",
                    isDefaultEnhancement: true,
                }),
            );

            expect(response.status).toBe(200);
            expect(db.transaction).toHaveBeenCalledTimes(1);
        });

        it("still rejects a transcription-only provider for enhancements", async () => {
            const response = await addProvider(
                jsonRequest({
                    provider: "ElevenLabs",
                    apiKey: "sk_test",
                    isDefaultEnhancement: true,
                }),
            );
            const body = await response.json();

            expect(response.status).toBe(400);
            expect(body.details).toEqual({ field: "isDefaultEnhancement" });
        });
    });

    describe("PUT /api/settings/ai/providers/[id]", () => {
        it("rejects flipping an existing Codex credential to transcription", async () => {
            queueSelect([
                { id: "cred-1", userId: "user-1", provider: "Codex" },
            ]);

            const response = await updateProvider(
                jsonRequest({ isDefaultTranscription: true }, "PUT"),
                idParams(),
            );
            const body = await response.json();

            expect(response.status).toBe(400);
            expect(body.details).toEqual({ field: "isDefaultTranscription" });
            expect(db.transaction).not.toHaveBeenCalled();
        });
    });

    describe("PUT /api/settings/ai/providers/default-transcription", () => {
        it("rejects a Claude Code credential and leaves the pointer alone", async () => {
            queueSelect([{ id: "cred-1", provider: "Claude Code" }]);

            const response = await setDefaultTranscription(
                jsonRequest({ providerId: "cred-1" }, "PUT"),
            );
            const body = await response.json();

            expect(response.status).toBe(400);
            expect(body.details).toEqual({ field: "providerId" });
            expect(setDefaultTranscriptionProvider).not.toHaveBeenCalled();
        });

        it("still accepts an audio-capable credential", async () => {
            queueSelect([{ id: "cred-1", provider: "OpenAI" }]);

            const response = await setDefaultTranscription(
                jsonRequest({ providerId: "cred-1" }, "PUT"),
            );

            expect(response.status).toBe(200);
            expect(setDefaultTranscriptionProvider).toHaveBeenCalledWith(
                "user-1",
                "cred-1",
            );
        });
    });
});
