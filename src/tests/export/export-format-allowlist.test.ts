import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: { select: vi.fn(), update: vi.fn(), insert: vi.fn() },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string | null | undefined) => v,
    decryptJsonField: (v: unknown) => v,
    encryptJsonField: (v: unknown) => v,
}));

import { GET as exportGET } from "@/app/api/export/route";
import { PUT as settingsPUT } from "@/app/api/settings/user/route";
import { db } from "@/db";
import { EXPORT_FORMATS } from "@/lib/export/formats";

/**
 * One `db.select()` result. `where(...)` is awaited directly by the
 * recordings/transcriptions/enhancements lookups and chained with
 * `.limit(1)` by the userSettings lookup, so it has to be both a promise
 * and an object carrying `.limit` -- see the same helper in
 * `export-route.test.ts`.
 */
function queueSelect(rows: unknown[]) {
    const where = vi.fn().mockReturnValue(
        Object.assign(Promise.resolve(rows), {
            limit: vi.fn().mockResolvedValue(rows),
        }),
    );
    // `innerJoin` returns the same shape so a joined read (the speaker-name
    // resolver) chains the same way an unjoined one does.
    const from: Record<string, unknown> = { where };
    from.innerJoin = vi.fn().mockReturnValue(from);
    from.leftJoin = vi.fn().mockReturnValue(from);
    (db.select as Mock).mockReturnValueOnce({
        from: vi.fn().mockReturnValue(from),
    });
}

function settingsRequest(body: Record<string, unknown>) {
    return new Request("https://app.example.com/api/settings/user", {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

/** The four reads `GET /api/export` performs before formatting. */
function queueExportReads() {
    // userSettings (defaultExportFormat fallback)
    queueSelect([]);
    // recordings
    queueSelect([
        {
            id: "rec-1",
            userId: "user-1",
            filename: "Planning Call",
            duration: 60000,
            startTime: new Date("2026-05-06T12:00:00.000Z"),
            filesize: 100,
            deletedAt: null,
        },
    ]);
    // transcriptions
    queueSelect([{ id: "tr-1", recordingId: "rec-1", text: "hello world" }]);
    // aiEnhancements
    queueSelect([]);
    // confirmed speaker attributions, for the name projection
    queueSelect([]);
}

// Regression coverage for the drift between the three places that each
// listed export formats independently. `PUT /api/settings/user` validated
// against ["json", "csv", "zip"] while the picker offered -- and the
// exporter implemented -- ["json", "txt", "srt", "vtt"], so every choice
// except JSON was rejected with "Failed to save settings", and the two
// formats the validator did allow had no exporter branch at all.
describe("export format allowlist", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (db.update as Mock).mockReturnValue({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
            }),
        });
    });

    describe("PUT /api/settings/user", () => {
        it.each(
            EXPORT_FORMATS,
        )("saves %s as the default export format", async (format) => {
            // existing settings row -> the handler takes the update path
            queueSelect([{ userId: "user-1" }]);

            const response = await settingsPUT(
                settingsRequest({ defaultExportFormat: format }),
            );

            expect(response.status).toBe(200);
            expect(db.update).toHaveBeenCalledTimes(1);
        });

        it("still rejects a format the exporter cannot produce", async () => {
            queueSelect([{ userId: "user-1" }]);

            const response = await settingsPUT(
                settingsRequest({ defaultExportFormat: "csv" }),
            );
            const body = await response.json();

            expect(response.status).toBe(400);
            expect(body.details).toEqual({ field: "defaultExportFormat" });
            expect(db.update).not.toHaveBeenCalled();
        });
    });

    describe("GET /api/export", () => {
        it.each(EXPORT_FORMATS)("serves %s", async (format) => {
            queueExportReads();

            const response = await exportGET(
                new Request(
                    `https://app.example.com/api/export?format=${format}`,
                ),
            );

            expect(response.status).toBe(200);
            expect(await response.text()).not.toBe("");
        });

        it("rejects an unsupported format without reading any recordings", async () => {
            // userSettings lookup only -- the guard fires before the rest
            queueSelect([]);

            const response = await exportGET(
                new Request("https://app.example.com/api/export?format=csv"),
            );
            const body = await response.json();

            expect(response.status).toBe(400);
            expect(body.details).toEqual({ field: "format" });
            // the recordings/transcriptions/enhancements reads never ran
            expect(db.select).toHaveBeenCalledTimes(1);
        });
    });
});
