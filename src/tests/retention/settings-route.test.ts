import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({
        user: { id: "user-1", email: "user@example.com" },
    }),
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string) => value,
    encryptText: (value: string) => value,
    decryptJsonField: <T>(value: T) => value,
    encryptJsonField: <T>(value: T) => value,
}));

const { existingRow, updates } = vi.hoisted(() => ({
    existingRow: { value: [] as Record<string, unknown>[] },
    updates: [] as Record<string, unknown>[],
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

import { GET, PUT } from "@/app/api/settings/user/route";

function existingSettings(overrides: Record<string, unknown> = {}) {
    return {
        userId: "user-1",
        autoDeleteRecordings: false,
        retentionDays: null,
        retentionDeleteAudio: false,
        retentionDeleteTranscript: false,
        retentionDeleteSummary: false,
        retentionRemoteOriginalDays: null,
        retentionLocalAudioDays: null,
        retentionLocalTranscriptDays: null,
        retentionLocalSummaryDays: null,
        ...overrides,
    };
}

function put(body: Record<string, unknown>) {
    return PUT(
        new Request("http://localhost/api/settings/user", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }),
    );
}

describe("independent retention settings", () => {
    beforeEach(() => {
        updates.length = 0;
        existingRow.value = [existingSettings()];
    });

    it("stores each retention period independently and retires the legacy policy", async () => {
        const response = await put({
            retentionRemoteOriginalDays: 7,
            retentionLocalAudioDays: 30,
            retentionLocalTranscriptDays: null,
            retentionLocalSummaryDays: 90,
        });

        expect(response.status).toBe(200);
        expect(updates.at(-1)).toMatchObject({
            retentionRemoteOriginalDays: 7,
            retentionLocalAudioDays: 30,
            retentionLocalTranscriptDays: null,
            retentionLocalSummaryDays: 90,
            autoDeleteRecordings: false,
            retentionDays: null,
            retentionDeleteAudio: false,
            retentionDeleteTranscript: false,
            retentionDeleteSummary: false,
        });
    });

    it("translates an existing shared policy before applying a partial edit", async () => {
        existingRow.value = [
            existingSettings({
                autoDeleteRecordings: true,
                retentionDays: 45,
                retentionDeleteAudio: true,
                retentionDeleteTranscript: true,
            }),
        ];

        const response = await put({ retentionLocalAudioDays: null });

        expect(response.status).toBe(200);
        expect(updates.at(-1)).toMatchObject({
            retentionRemoteOriginalDays: null,
            retentionLocalAudioDays: null,
            retentionLocalTranscriptDays: 45,
            retentionLocalSummaryDays: null,
        });
    });

    it("keeps every type off when an existing shared policy is disabled", async () => {
        existingRow.value = [
            existingSettings({
                autoDeleteRecordings: true,
                retentionDays: 30,
                retentionDeleteAudio: true,
                retentionDeleteTranscript: true,
                retentionDeleteSummary: true,
            }),
        ];

        const response = await put({
            retentionRemoteOriginalDays: null,
            retentionLocalAudioDays: null,
            retentionLocalTranscriptDays: null,
            retentionLocalSummaryDays: null,
        });

        expect(response.status).toBe(200);
        expect(updates.at(-1)).toMatchObject({
            retentionRemoteOriginalDays: null,
            retentionLocalAudioDays: null,
            retentionLocalTranscriptDays: null,
            retentionLocalSummaryDays: null,
            autoDeleteRecordings: false,
            retentionDays: null,
            retentionDeleteAudio: false,
            retentionDeleteTranscript: false,
            retentionDeleteSummary: false,
        });
    });

    it.each([
        0,
        366,
        1.5,
        "30",
    ])("rejects invalid retention value %s", async (value) => {
        const response = await put({ retentionLocalAudioDays: value });
        expect(response.status).toBe(400);
        expect(updates).toHaveLength(0);
    });

    it("returns legacy settings through the independent API shape", async () => {
        existingRow.value = [
            existingSettings({
                autoDeleteRecordings: true,
                retentionDays: 60,
                retentionDeleteAudio: true,
                retentionDeleteSummary: true,
            }),
        ];

        const response = await GET(
            new Request("http://localhost/api/settings/user"),
        );
        const body = await response.json();

        expect(body).toMatchObject({
            retentionRemoteOriginalDays: null,
            retentionLocalAudioDays: 60,
            retentionLocalTranscriptDays: null,
            retentionLocalSummaryDays: 60,
        });
        expect(body).not.toHaveProperty("autoDeleteRecordings");
    });
});
