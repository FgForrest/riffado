/**
 * Transcript corrections against a real PostgreSQL: accepting and taking
 * them back under the writer rule, and carrying them over when the
 * transcript is written again (`transcriptRewrittenInTx`).
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { eq } from "drizzle-orm";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    people,
    recordingFolders,
    recordings,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current) {
                    throw new Error("test database was not initialized");
                }
                const value = current[property];
                return typeof value === "function"
                    ? value.bind(current)
                    : value;
            },
        },
    );
    return {
        dbProxy: proxy,
        dbRef: ref,
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
        },
    };
});

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: null }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

import { encryptText } from "@/lib/encryption/fields";
import { addRecordingToFolder, unshareRecording } from "@/lib/folders/folders";
import {
    acceptCorrection,
    listCorrections,
    revertCorrection,
} from "@/lib/knowledge/corrections";
import { deletePerson } from "@/lib/knowledge/people";
import { confirmedOverlays, correctionOverlay } from "@/lib/learn/llm-input";
import { ensureOrgAccount } from "@/lib/org/account";
import { upsertTranscription } from "@/lib/transcription/persist";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const BOB = "user-bob";
const REC = "rec-meeting";
const DIARIZED = "gpt-4o-transcribe-diarize";

const FIRST: TranscriptTurn[] = [
    {
        speaker: "speaker_0",
        startMs: 0,
        endMs: 4_000,
        text: "Dobrý den, tady Novák z Orionu.",
    },
    {
        speaker: "speaker_1",
        startMs: 4_000,
        endMs: 9_000,
        text: "Ahoj Honzo, jak to jde s projektem Tavesi?",
    },
];

function anchorIn(turns: TranscriptTurn[], turnIndex: number, heard: string) {
    const charStart = turns[turnIndex]?.text.indexOf(heard) ?? -1;
    return { turnIndex, charStart, charEnd: charStart + heard.length, heard };
}

async function refusal(promise: Promise<unknown>) {
    return promise.then(
        () => null,
        (caught: unknown) =>
            caught as { statusCode?: number; code?: string; message: string },
    );
}

describeWithDatabase("transcript corrections (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let jan = "";
    let orgJan = "";
    let bobsPerson = "";
    let transcriptId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "corrections",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    function write(turns: TranscriptTurn[] | undefined, actor = OWNER) {
        return upsertTranscription({
            userId: OWNER,
            recordingId: REC,
            text: (turns ?? FIRST).map((t) => t.text).join("\n"),
            detectedLanguage: "cs",
            source: "riffado",
            provider: "openai",
            model: DIARIZED,
            turns,
            actorUserId: actor,
        });
    }

    async function revision(): Promise<number> {
        const [row] = await db()
            .select({ revision: transcriptions.revision })
            .from(transcriptions)
            .where(eq(transcriptions.id, transcriptId));
        return row?.revision ?? -1;
    }

    function correct(
        overrides: Partial<Parameters<typeof acceptCorrection>[0]> = {},
    ) {
        return (async () =>
            acceptCorrection({
                userId: OWNER,
                transcriptionId: transcriptId,
                revision: await revision(),
                anchor: anchorIn(FIRST, 0, "Novák"),
                kind: "correct",
                target: { personId: jan },
                replacement: "Novotný",
                actorUserId: OWNER,
                orgUserId,
                ...overrides,
            }))();
    }

    async function share() {
        // Every voice answered, so the share gate lets it through.
        for (const label of ["speaker_0", "speaker_1"]) {
            await db().insert(transcriptSpeakers).values({
                userId: OWNER,
                transcriptionId: transcriptId,
                label,
                personId: null,
                source: "user",
                status: "confirmed",
                markedUnknown: true,
                confirmedByUserId: OWNER,
            });
        }
        const [root] = await db()
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId));
        await addRecordingToFolder({
            userId: OWNER,
            recordingId: REC,
            folderId: root?.id ?? "",
        });
    }

    beforeEach(async () => {
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "owner@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await insertRecordings(db(), {
            id: REC,
            userId: OWNER,
            deviceSn: "SN-1",
            plaudFileId: "plaud-1",
            filename: encryptText("Weekly"),
            duration: 9_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:09Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${OWNER}/rec.mp3`,
            plaudVersion: "1",
        });
        const inserted = await db()
            .insert(people)
            .values([
                { userId: OWNER, displayName: encryptText("Jan Novotný") },
                { userId: orgUserId, displayName: encryptText("Jan Novotný") },
                { userId: BOB, displayName: encryptText("Bobův člověk") },
            ])
            .returning({ id: people.id });
        jan = inserted[0]?.id ?? "";
        orgJan = inserted[1]?.id ?? "";
        bobsPerson = inserted[2]?.id ?? "";
        await write(FIRST);
        const [row] = await db()
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, REC));
        transcriptId = row?.id ?? "";
    });

    it("accepts a correction, stores it encrypted, and lists it", async () => {
        const id = await correct();

        expect(await listCorrections(OWNER, transcriptId)).toEqual([
            {
                id,
                transcriptRevision: await revision(),
                turnIndex: 0,
                charStart: 16,
                charEnd: 21,
                heard: "Novák",
                kind: "correct",
                targetPersonId: jan,
                targetEntityId: null,
                replacement: "Novotný",
                preTicked: false,
                passId: null,
            },
        ]);
        const [row] = await db()
            .select()
            .from(transcriptCorrections)
            .where(eq(transcriptCorrections.id, id));
        expect(row?.heard).not.toContain("Novák");
        expect(row?.replacement).not.toContain("Novotný");
        expect(row?.createdByUserId).toBe(OWNER);
    });

    it("keeps a link as spoken, pointing at the person", async () => {
        await correct({
            anchor: anchorIn(FIRST, 1, "Honzo"),
            kind: "link",
            replacement: "ignored",
        });
        const [link] = await listCorrections(OWNER, transcriptId);
        expect(link).toMatchObject({
            kind: "link",
            heard: "Honzo",
            replacement: null,
        });
    });

    it("refuses what does not fit, writing nothing", async () => {
        const stale = await refusal(
            correct({ revision: (await revision()) - 1 }),
        );
        expect(stale).toMatchObject({ statusCode: 409 });
        expect(
            await refusal(
                correct({
                    anchor: { ...anchorIn(FIRST, 0, "Novák"), charStart: 3 },
                }),
            ),
        ).toMatchObject({ statusCode: 400 });
        expect(await refusal(correct({ replacement: "  " }))).toMatchObject({
            statusCode: 400,
        });
        expect(await refusal(correct({ replacement: "Novák" }))).toMatchObject({
            statusCode: 400,
        });
        expect(await listCorrections(OWNER, transcriptId)).toEqual([]);

        await correct();
        expect(
            await refusal(
                correct({
                    anchor: {
                        turnIndex: 0,
                        charStart: 19,
                        charEnd: 23,
                        heard: "ák z",
                    },
                }),
            ),
        ).toMatchObject({ statusCode: 409 });
    });

    it("answers another account's person as a missing one", async () => {
        const missing = await refusal(
            correct({ target: { personId: "no-such" } }),
        );
        const foreign = await refusal(
            correct({ target: { personId: bobsPerson } }),
        );
        expect(missing).toMatchObject({ statusCode: 404 });
        expect(foreign).toMatchObject({
            statusCode: missing?.statusCode,
            code: missing?.code,
            message: missing?.message,
        });
    });

    it("targets the person a merged-away one was folded into", async () => {
        const [folded] = await db()
            .insert(people)
            .values({
                userId: OWNER,
                displayName: encryptText("Honza"),
                mergedIntoId: jan,
            })
            .returning({ id: people.id });
        await correct({ target: { personId: folded?.id ?? "" } });
        const [row] = await listCorrections(OWNER, transcriptId);
        expect(row?.targetPersonId).toBe(jan);
    });

    it("takes a correction back, and answers another account's as missing", async () => {
        const id = await correct();
        const args = {
            userId: OWNER,
            transcriptionId: transcriptId,
            actorUserId: OWNER,
            orgUserId,
        };
        const missing = await refusal(
            revertCorrection({ ...args, correctionId: "no-such" }),
        );
        expect(missing).toMatchObject({ statusCode: 404 });
        // Bob addressing the owner's transcript: to him it is not there.
        expect(
            await refusal(
                revertCorrection({
                    ...args,
                    actorUserId: BOB,
                    correctionId: id,
                }),
            ),
        ).toMatchObject({ statusCode: 404 });
        // Bob addressing his own (empty) scope with the owner's id.
        expect(
            await refusal(
                revertCorrection({
                    ...args,
                    userId: BOB,
                    actorUserId: BOB,
                    correctionId: id,
                }),
            ),
        ).toMatchObject({ statusCode: 404 });

        await revertCorrection({ ...args, correctionId: id });
        expect(await listCorrections(OWNER, transcriptId)).toEqual([]);
    });

    /**
     * A correction left in the owner's scope on a shared transcript, as a
     * share leaves one it cannot publish (naming an entity of a private
     * type the Organization has not adopted).
     */
    async function ownersPrivateCorrection(heard: string, turnIndex = 0) {
        const anchor = anchorIn(FIRST, turnIndex, heard);
        await db()
            .insert(transcriptCorrections)
            .values({
                userId: OWNER,
                transcriptionId: transcriptId,
                transcriptRevision: await revision(),
                turnIndex: anchor.turnIndex,
                charStart: anchor.charStart,
                charEnd: anchor.charEnd,
                heard: encryptText(heard),
                heardHmac: "h",
                kind: "correct",
                targetPersonId: jan,
                replacement: encryptText("Novotný"),
            });
    }

    it("lets only the organization account change them while shared, with Organization people", async () => {
        await correct();
        await share();

        expect(
            await refusal(correct({ anchor: anchorIn(FIRST, 1, "Tavesi") })),
        ).toMatchObject({ statusCode: 409, code: "RECORDING_SHARED" });
        const [unknown] = await db()
            .insert(people)
            .values({ userId: OWNER, displayName: encryptText("Tajný") })
            .returning({ id: people.id });
        expect(
            await refusal(
                correct({
                    anchor: anchorIn(FIRST, 1, "Honzo"),
                    kind: "link",
                    target: { personId: unknown?.id ?? "" },
                    actorUserId: orgUserId,
                }),
            ),
        ).toMatchObject({ statusCode: 404, message: "Person not found" });
        await correct({
            anchor: anchorIn(FIRST, 1, "Honzo"),
            kind: "link",
            target: { personId: orgJan },
            actorUserId: orgUserId,
        });

        // Sharing published the owner's correction (and made Jan the
        // Organization's); one it could not publish stays the owner's.
        // Everyone reads the Organization's while it is shared, the owner
        // too: their unpublishable one waits unseen.
        await ownersPrivateCorrection("Orionu");
        expect(
            (await listCorrections(OWNER, transcriptId)).map((c) => c.heard),
        ).toEqual(["Novák", "Honzo"]);
    });

    it("lets the curator correct words a waiting private correction covers, and the Organization's wins at withdrawal", async () => {
        await share();
        await ownersPrivateCorrection("Novák");
        await ownersPrivateCorrection("Orionu");
        const curators = await correct({
            target: { personId: orgJan },
            replacement: "Novotný",
            actorUserId: orgUserId,
        });
        expect(
            (await listCorrections(OWNER, transcriptId)).map((c) => c.id),
        ).toEqual([curators]);

        await unshareRecording(OWNER, REC, { withdraw: true });

        const back = await listCorrections(OWNER, transcriptId);
        expect(back.map((c) => [c.heard, c.targetPersonId])).toEqual([
            ["Novák", orgJan],
            ["Orionu", jan],
        ]);
        expect(back[0]?.id).toBe(curators);
    });

    it("reads the owner's own corrections once the instance runs local, the Organization's not at all", async () => {
        await share();
        await ownersPrivateCorrection("Orionu");
        await correct({
            target: { personId: orgJan },
            actorUserId: orgUserId,
        });
        const owners = (
            await db()
                .select({ id: transcriptCorrections.id })
                .from(transcriptCorrections)
                .where(eq(transcriptCorrections.userId, OWNER))
        ).map((row) => row.id);
        expect(owners).toHaveLength(1);
        mockEnv.SELF_HOST_MODE = "local";
        try {
            expect(
                (await listCorrections(OWNER, transcriptId)).map((c) => c.id),
            ).toEqual(owners);
        } finally {
            mockEnv.SELF_HOST_MODE = "shared";
        }
    });

    it("reads every transcript's corrections for an export at once, each in its view, a deleted recording's not", async () => {
        await share();
        await ownersPrivateCorrection("Orionu");
        await correct({
            target: { personId: orgJan },
            actorUserId: orgUserId,
        });
        const [transcript] = await db()
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.id, transcriptId));
        if (!transcript) throw new Error("no transcript");
        const batched = async () =>
            (await confirmedOverlays({ ownerUserId: OWNER })).get(transcriptId);
        const alone = () => correctionOverlay(transcript, { pending: false });

        const organizations = async () =>
            (await confirmedOverlays({ organization: true })).get(transcriptId);

        expect((await alone()).length).toBeGreaterThan(0);
        expect(await batched()).toEqual(await alone());
        // The Organization's library reads it as its members do.
        expect(await organizations()).toEqual(await alone());
        await unshareRecording(OWNER, REC, { withdraw: true });
        expect(await batched()).toEqual(await alone());
        expect(await organizations()).toBeUndefined();

        await db()
            .update(recordings)
            .set({ deletedAt: new Date() })
            .where(eq(recordings.id, REC));
        expect(await batched()).toBeUndefined();
    });

    it("keeps the Organization's correction, not a waiting one on the same words, through a re-transcription", async () => {
        await share();
        await ownersPrivateCorrection("Novák");
        const curators = await correct({
            target: { personId: orgJan },
            actorUserId: orgUserId,
        });
        await write(FIRST, orgUserId);
        expect(
            await db()
                .select({ id: transcriptCorrections.id })
                .from(transcriptCorrections),
        ).toEqual([{ id: curators }]);
    });

    it("keeps each scope's corrections in its scope, and rechecks them all", async () => {
        await share();
        await ownersPrivateCorrection("Novák");
        await correct({
            anchor: anchorIn(FIRST, 1, "Tavesi"),
            replacement: "Tavesy",
            target: { personId: orgJan },
            actorUserId: orgUserId,
        });
        const scopes = async () =>
            (
                await db()
                    .select({
                        userId: transcriptCorrections.userId,
                        heard: transcriptCorrections.heard,
                        charStart: transcriptCorrections.charStart,
                        transcriptRevision:
                            transcriptCorrections.transcriptRevision,
                    })
                    .from(transcriptCorrections)
                    .orderBy(transcriptCorrections.turnIndex)
            ).map(({ heard: _heard, ...row }) => row);
        expect((await scopes()).map((row) => row.userId)).toEqual([
            OWNER,
            orgUserId,
        ]);

        // The curator re-transcribes; the Organization's correction moves.
        const reworded: TranscriptTurn[] = [
            FIRST[0] as TranscriptTurn,
            {
                speaker: "speaker_1",
                startMs: 4_000,
                endMs: 9_000,
                text: "Ahoj Honzo, jak jde projekt Tavesi?",
            },
        ];
        await write(reworded, orgUserId);
        expect(await scopes()).toEqual([
            {
                userId: OWNER,
                charStart: 16,
                transcriptRevision: await revision(),
            },
            {
                userId: orgUserId,
                charStart: 28,
                transcriptRevision: await revision(),
            },
        ]);
        // The curator takes back only the Organization's.
        const [owners] = await db()
            .select({ id: transcriptCorrections.id })
            .from(transcriptCorrections)
            .where(eq(transcriptCorrections.userId, OWNER));
        expect(
            await refusal(
                revertCorrection({
                    userId: OWNER,
                    transcriptionId: transcriptId,
                    actorUserId: orgUserId,
                    orgUserId,
                    correctionId: owners?.id ?? "",
                }),
            ),
        ).toMatchObject({ statusCode: 404 });
    });

    it("carries corrections onto a new transcript, dropping those whose words are gone", async () => {
        await correct();
        await correct({
            anchor: anchorIn(FIRST, 1, "Tavesi"),
            replacement: "Tavesy",
        });
        await correct({
            anchor: anchorIn(FIRST, 1, "Honzo"),
            kind: "link",
            preTicked: true,
        });

        const second: TranscriptTurn[] = [
            {
                speaker: "speaker_1",
                startMs: 0,
                endMs: 4_100,
                text: "Dobrý den, tady je Novák z Orionu.",
            },
            {
                speaker: "speaker_0",
                startMs: 4_100,
                endMs: 9_000,
                text: "Ahoj Honzo, jak to jde s projektem Seneca?",
            },
        ];
        await write(second);

        const after = await listCorrections(OWNER, transcriptId);
        expect(after).toEqual([
            expect.objectContaining({
                heard: "Novák",
                turnIndex: 0,
                charStart: 19,
                charEnd: 24,
                transcriptRevision: await revision(),
            }),
        ]);
    });

    it("drops every correction when the new transcript has no timed turns", async () => {
        await correct();
        await write(undefined);
        expect(await listCorrections(OWNER, transcriptId)).toEqual([]);
    });

    it("goes with the person it targets", async () => {
        await correct();
        await deletePerson(OWNER, jan);
        expect(await listCorrections(OWNER, transcriptId)).toEqual([]);
    });
});
