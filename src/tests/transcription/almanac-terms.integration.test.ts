/**
 * The Almanac names a transcription is told to expect, against a real
 * PostgreSQL: the recorder first, then what the owner's transcripts named,
 * from the owner's and the Organization's records, never another
 * account's; on the Organization view, the Organization's alone.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { people, transcriptions, transcriptSpeakers, users } from "@/db/schema";
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
            KNOWLEDGE_MEMORY_MB: 64,
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

import { encryptText } from "@/lib/encryption/fields";
import { addAlias } from "@/lib/knowledge/aliases";
import { createEntity } from "@/lib/knowledge/entities";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { createPerson } from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import { almanacTermsFor } from "@/lib/transcription/almanac-terms";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";

describeWithDatabase("Almanac terms for transcription (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    async function transcriptNaming(
        id: string,
        named: { label: string; personId: string; status?: "rejected" }[],
    ): Promise<void> {
        await insertRecordings(db(), {
            id,
            userId: ALICE,
            deviceSn: "SN-1",
            plaudFileId: `plaud-${id}`,
            filename: encryptText("Weekly"),
            duration: 10_000,
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T10:00:10Z"),
            filesize: 11,
            fileMd5: "0".repeat(32),
            storageType: "local",
            storagePath: `${ALICE}/${id}.mp3`,
            plaudVersion: "1",
        });
        const [transcript] = await db()
            .insert(transcriptions)
            .values({
                recordingId: id,
                userId: ALICE,
                text: encryptText("speaker_0: Hello."),
                detectedLanguage: "cs",
                provider: "ElevenLabs",
                model: "scribe_v2+diarize",
                source: "riffado",
            })
            .returning({ id: transcriptions.id });
        for (const speaker of named) {
            await db()
                .insert(transcriptSpeakers)
                .values({
                    userId: ALICE,
                    transcriptionId: transcript?.id ?? "",
                    label: speaker.label,
                    personId: speaker.personId,
                    source: "user",
                    status: speaker.status ?? "confirmed",
                });
        }
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "almanac_terms",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        knowledgeStore().invalidateAll();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await seedCoreVocabulary();
    });

    it("puts the recorder first and what the transcripts named next, from both scopes", async () => {
        const [zora] = await db()
            .insert(people)
            .values({ userId: orgUserId, displayName: encryptText("Zora Kos") })
            .returning({ id: people.id });
        await createPerson({
            userId: ALICE,
            displayName: "Alice Malá",
            primaryEmail: "alice@example.test",
        });
        const eva = await createPerson({
            userId: ALICE,
            displayName: "Eva Svobodová",
        });
        const rejected = await createPerson({
            userId: ALICE,
            displayName: "Ada Bílá",
        });
        const orion = await createEntity(ALICE, {
            typeKey: "project",
            name: "Orion",
        });
        await addAlias(ALICE, { entityId: orion.id }, "Ori");
        await createEntity(BOB, { typeKey: "project", name: "Borealis" });
        await transcriptNaming("rec-1", [
            { label: "speaker_0", personId: eva.id },
            { label: "speaker_1", personId: zora?.id ?? "" },
            { label: "speaker_2", personId: rejected.id, status: "rejected" },
        ]);
        await transcriptNaming("rec-2", [
            { label: "speaker_0", personId: eva.id },
        ]);

        const terms = await almanacTermsFor({
            ownerUserId: ALICE,
            shared: false,
            language: "cs",
        });
        expect(terms.map((term) => term.text)).toEqual([
            "Alice Malá",
            "Eva Svobodová",
            "Zora Kos",
            "Ada Bílá",
            "Orion",
            "Ori",
        ]);

        const shared = await almanacTermsFor({
            ownerUserId: ALICE,
            shared: true,
            language: "cs",
        });
        expect(shared.map((term) => term.text)).toEqual(["Zora Kos"]);
    });

    it("sends nothing for an empty Almanac", async () => {
        expect(
            await almanacTermsFor({
                ownerUserId: ALICE,
                shared: false,
                language: null,
            }),
        ).toEqual([]);
    });
});
