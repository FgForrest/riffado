import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/posthog-server", () => ({
    captureServerException: vi.fn(),
    captureServerEvent: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        BETTER_AUTH_SECRET: "test-secret",
        DATABASE_URL: "postgres://unused",
    },
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
}));

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

import {
    GET as getSpeakers,
    PUT as putSpeaker,
} from "@/app/api/recordings/[id]/speakers/route";
import { db } from "@/db";
import { transcriptions } from "@/db/schema";
import { exprBindsValue, exprReferencesColumn } from "../fixtures/drizzle-expr";

const RECORDING_ID = "rec-1";

/** Every `where` expression the route built, in the order it built them. */
let wheres: unknown[] = [];

/**
 * One `db.select()` answer. Resolves to `rows` whether the caller ends the
 * chain with `.limit()` or awaits the `where()` directly, so both the
 * transcript lookup and the joined speaker read can share a queue.
 */
function selectAnswer(rows: unknown[]) {
    // A real promise with the terminals assigned onto it resolves whether
    // the caller ends the chain or awaits the `where` directly.
    const afterWhere = Object.assign(Promise.resolve(rows), {
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockResolvedValue(rows),
    });
    const node: Record<string, unknown> = {};
    node.from = vi.fn(() => node);
    node.leftJoin = vi.fn(() => node);
    node.innerJoin = vi.fn(() => node);
    node.where = vi.fn((expr: unknown) => {
        wheres.push(expr);
        return afterWhere;
    });
    return node;
}

function queueSelects(...answers: unknown[][]): void {
    const mock = db.select as Mock;
    for (const rows of answers) {
        mock.mockReturnValueOnce(selectAnswer(rows));
    }
}

function context(id = RECORDING_ID) {
    return { params: Promise.resolve({ id }) };
}

function putRequest(body: unknown, query = ""): Request {
    return new Request(
        `http://localhost/api/recordings/${RECORDING_ID}/speakers${query}`,
        { method: "PUT", body: JSON.stringify(body) },
    );
}

describe("speakers route and ownership", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        wheres = [];
        (db.update as Mock).mockReturnValue({
            set: vi.fn().mockReturnValue({ where: vi.fn() }),
        });
    });

    it("scopes the transcript lookup by userId and 404s on somebody else's", async () => {
        queueSelects([]);

        const response = await getSpeakers(
            new Request(
                `http://localhost/api/recordings/${RECORDING_ID}/speakers`,
            ),
            context() as never,
        );

        expect(response.status).toBe(404);
        expect(exprReferencesColumn(wheres[0], transcriptions.userId)).toBe(
            true,
        );
        expect(
            exprReferencesColumn(wheres[0], transcriptions.recordingId),
        ).toBe(true);
    });

    it("refuses to write an attribution against somebody else's transcript", async () => {
        queueSelects([]);

        const response = await putSpeaker(
            putRequest({ label: "speaker_0", personId: "person-1" }),
            context() as never,
        );

        expect(response.status).toBe(404);
        expect(db.insert).not.toHaveBeenCalled();
    });

    it("refuses a personId the session user does not own", async () => {
        // The transcript is the caller's; the person is not, so the person
        // lookup comes back empty.
        queueSelects([{ id: "tx-1" }], []);

        const response = await putSpeaker(
            putRequest({ label: "speaker_0", personId: "person-theirs" }),
            context() as never,
        );

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
            error: "Person not found",
        });
        // The upsert conflicts on (transcriptionId, label) alone, so the
        // person check is the only thing keeping a caller off a slot.
        expect(db.insert).not.toHaveBeenCalled();
    });

    it("writes a user-confirmed attribution, the only kind that projects", async () => {
        queueSelects(
            [{ id: "tx-1" }],
            [
                {
                    id: "person-1",
                    displayName: "Jan",
                    primaryEmail: null,
                    notes: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            ],
            [],
        );
        const values = vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        });
        (db.insert as Mock).mockReturnValue({ values });

        const response = await putSpeaker(
            putRequest({ label: "speaker_0", personId: "person-1" }),
            context() as never,
        );

        expect(response.status).toBe(200);
        expect(values).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "user-1",
                transcriptionId: "tx-1",
                label: "speaker_0",
                personId: "person-1",
                source: "user",
                status: "confirmed",
            }),
        );
    });

    it("attributes against the transcript the caller named, not the recording", async () => {
        queueSelects([{ id: "tx-plaud" }], []);

        await getSpeakers(
            new Request(
                `http://localhost/api/recordings/${RECORDING_ID}/speakers?source=plaud`,
            ),
            context() as never,
        );
        const plaudWhere = wheres[0];

        wheres = [];
        queueSelects([{ id: "tx-riffado" }], []);
        await getSpeakers(
            new Request(
                `http://localhost/api/recordings/${RECORDING_ID}/speakers`,
            ),
            context() as never,
        );
        const riffadoWhere = wheres[0];

        // One recording can hold two transcripts whose speaker_0 is a
        // different human, which is why the overlay hangs off the transcript.
        expect(exprBindsValue(plaudWhere, "plaud")).toBe(true);
        expect(exprBindsValue(plaudWhere, "riffado")).toBe(false);
        expect(exprBindsValue(riffadoWhere, "riffado")).toBe(true);
    });
});
