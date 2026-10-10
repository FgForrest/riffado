/**
 * The `knowledge:read` tools of the external MCP server, against a real
 * PostgreSQL: a user reads their own and the Organization's knowledge, a
 * service caller the Organization's alone; fact quotes only with
 * `transcripts:read` and only from readable recordings; mishearings from
 * taught heard-as forms and `correct` corrections, never another user's or
 * a deleted recording's.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    knowledgeFactEvidence,
    recordings,
    transcriptCorrections,
    transcriptions,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, dbRef, mockEnv, allowScan } = vi.hoisted(() => {
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
        allowScan: vi.fn(async () => true),
        mockEnv: {
            IS_HOSTED: false,
            SELF_HOST_MODE: "shared",
            ORG_ACCOUNT_EMAIL: "org@example.test",
            ORG_ACCOUNT_PASSWORD: "organization-password",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
            DATABASE_URL: "postgres://unused",
            APP_URL: "https://riffado.example.com",
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
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/export/document-sidecars", () => ({
    exportRecordingSidecarsIfEnabled: vi.fn().mockResolvedValue(undefined),
    refreshExistingRecordingSidecars: vi.fn().mockResolvedValue(undefined),
    removeRecordingSidecar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/mcp/rate-limit", () => ({ allowMcpScan: allowScan }));
vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

import { encryptText } from "@/lib/encryption/fields";
import { addAlias } from "@/lib/knowledge/aliases";
import { acceptCorrection } from "@/lib/knowledge/corrections";
import { createEntity } from "@/lib/knowledge/entities";
import { confirmManualFact } from "@/lib/knowledge/facts";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { domainLookupHash } from "@/lib/knowledge/lookup-hash";
import { addPersonNotes, createPerson } from "@/lib/knowledge/people";
import {
    createOrgType,
    createPrivateType,
    seedCoreVocabulary,
} from "@/lib/knowledge/vocabulary";
import type { McpCaller } from "@/lib/mcp/caller";
import { McpToolError } from "@/lib/mcp/errors";
import { buildMcpServer, type McpToolDef } from "@/lib/mcp/registry";
import type { McpRole } from "@/lib/mcp/roles";
import { KNOWLEDGE_TOOLS } from "@/lib/mcp/tools/knowledge";
import { ensureOrgAccount } from "@/lib/org/account";
import { upsertTranscription } from "@/lib/transcription/persist";
import type { TranscriptTurn } from "@/lib/transcription/turns";
import {
    insertRecording,
    insertTranscript,
    serviceCaller,
    shareRecording,
    userCaller,
} from "@/tests/mcp/fixtures";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ALICE = "user-alice";
const BOB = "user-bob";
const PRIVATE_NOTE = "Alice's private remark about Jan";

function tool(name: string): McpToolDef {
    const found = KNOWLEDGE_TOOLS.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
}

async function call(
    caller: McpCaller,
    name: string,
    args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
    return tool(name).run({ caller, touched: [] }, args);
}

async function failure(
    caller: McpCaller,
    name: string,
    args: Record<string, unknown>,
): Promise<McpToolError> {
    const caught = await call(caller, name, args).then(
        () => null,
        (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(McpToolError);
    return caught as McpToolError;
}

interface Item {
    id: string;
    kind: string;
    type: string;
    name: string;
    scope: string;
}

interface FactOut {
    id: string;
    relation: string;
    object: { id?: string; name?: string; literal?: string };
    scope: string;
    evidence?: {
        recording_id: string;
        url: string;
        start_ms: number;
        quote: string;
    }[];
}

interface MishearingOut {
    heard: string;
    replacement: string | null;
    target: { id: string; kind: string; type: string; name: string };
    language: string | null;
    provider: string | null;
    sources: string[];
}

describeWithDatabase("MCP knowledge tools (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    let privateTypeKey = "";
    let orgTypeKey = "";
    const ids: Record<string, string> = {};

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    const alice = (roles: McpRole[] = ["knowledge:read"]) =>
        userCaller(ALICE, "alice@example.test", roles, orgUserId);
    const service = (roles: McpRole[] = ["knowledge:read"]) =>
        serviceCaller(orgUserId, roles);

    async function writeTranscript(
        userId: string,
        recordingId: string,
        turns: TranscriptTurn[],
        language: string,
    ): Promise<{ id: string; revision: number }> {
        await upsertTranscription({
            userId,
            recordingId,
            text: turns.map((turn) => turn.text).join("\n"),
            detectedLanguage: language,
            source: "riffado",
            provider: "openai",
            model: "gpt-4o-transcribe-diarize",
            turns,
        });
        const [row] = await db()
            .select({
                id: transcriptions.id,
                revision: transcriptions.revision,
            })
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, recordingId));
        if (!row) throw new Error("transcript not written");
        return row;
    }

    function anchor(turns: TranscriptTurn[], turnIndex: number, heard: string) {
        const charStart = turns[turnIndex]?.text.indexOf(heard) ?? -1;
        if (charStart < 0) throw new Error(`"${heard}" not in turn`);
        return {
            turnIndex,
            charStart,
            charEnd: charStart + heard.length,
            heard,
        };
    }

    async function addEvidence(
        factId: string,
        scope: string,
        recordingId: string,
        transcriptionId: string,
        startMs: number,
        quote: string,
        status: "supported" | "wording_changed" = "supported",
    ): Promise<void> {
        await db()
            .insert(knowledgeFactEvidence)
            .values({
                userId: scope,
                factId,
                transcriptionId,
                itemId: recordingId,
                transcriptRevision: 1,
                startMs,
                endMs: startMs + 1_000,
                quote: encryptText(quote),
                status,
            });
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "mcp_knowledge",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;

        await db()
            .insert(users)
            .values([
                { id: ALICE, email: "alice@example.test" },
                { id: BOB, email: "bob@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        if (!orgUserId) throw new Error("organization account missing");
        await seedCoreVocabulary();

        privateTypeKey = await createPrivateType(ALICE, {
            kind: "entity",
            label: "Hobby",
        });
        orgTypeKey = await createOrgType(orgUserId, {
            kind: "entity",
            label: "Venue",
        });

        const person = async (userId: string, name: string, notes?: string) =>
            (await createPerson({ userId, displayName: name, notes })).id;
        ids.orgJan = await person(orgUserId, "Jan Novotný", "Head of sales");
        ids.alicePetra = await person(ALICE, "Petra Malá");
        ids.bobKarel = await person(BOB, "Karel Bobek");
        ids.bobMartin = await person(BOB, "Martin Král");
        for (const letter of ["A", "B", "C", "D", "E", "F"]) {
            ids[`martin${letter}`] = await person(
                orgUserId,
                `Martin ${letter}${letter}${letter}`,
            );
        }
        await addPersonNotes(ids.orgJan, ALICE, PRIVATE_NOTE);
        await addAlias(ALICE, { personId: ids.orgJan }, "Honza");

        const entity = async (userId: string, typeKey: string, name: string) =>
            (await createEntity(userId, { typeKey, name })).id;
        ids.orion = await entity(ALICE, "project", "Orion");
        ids.bobsOrion = await entity(BOB, "project", "Orion");
        ids.atlas = await entity(orgUserId, "project", "Atlas");
        ids.lumen = await entity(orgUserId, "organization", "Lumen Works");
        ids.kestrel = await entity(ALICE, "organization", "Kestrel Labs");
        ids.hobby = await entity(ALICE, privateTypeKey, "Sailing");
        ids.venue = await entity(orgUserId, orgTypeKey, "Main Hall");
        for (let index = 0; index < 55; index++) {
            await entity(
                orgUserId,
                "term",
                `Term ${String(index).padStart(2, "0")}`,
            );
        }

        ids.factLeads = await confirmManualFact(ALICE, {
            subject: { personId: ids.orgJan },
            relationKey: "leads",
            object: { entityId: ids.orion },
        });
        ids.factWorksFor = await confirmManualFact(orgUserId, {
            subject: { personId: ids.orgJan },
            relationKey: "works_for",
            object: { entityId: ids.lumen },
        });
        ids.factRole = await confirmManualFact(orgUserId, {
            subject: { personId: ids.orgJan },
            relationKey: "has_role",
            object: { literal: "Sales lead" },
        });
        ids.factBob = await confirmManualFact(BOB, {
            subject: { personId: ids.bobKarel },
            relationKey: "leads",
            object: { entityId: ids.bobsOrion },
        });

        await insertRecording(db(), {
            id: "r1",
            userId: ALICE,
            startTime: new Date("2026-09-05T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r2",
            userId: BOB,
            startTime: new Date("2026-09-04T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r3",
            userId: BOB,
            startTime: new Date("2026-09-03T10:00:00Z"),
        });
        await insertRecording(db(), {
            id: "r4",
            userId: BOB,
            startTime: new Date("2026-09-06T10:00:00Z"),
        });
        await shareRecording(db(), "r3", orgUserId);
        await shareRecording(db(), "r4", orgUserId);
        const t1 = await insertTranscript(db(), "r1", ALICE);
        const t2 = await insertTranscript(db(), "r2", BOB);
        const t3 = await insertTranscript(db(), "r3", BOB);
        const t4 = await insertTranscript(db(), "r4", BOB);
        const worksFor = ids.factWorksFor;
        await addEvidence(worksFor, orgUserId, "r4", t4, 500, "Q-r4");
        await addEvidence(worksFor, orgUserId, "r1", t1, 100, "Q-r1");
        await addEvidence(worksFor, orgUserId, "r2", t2, 100, "Q-r2-bob");
        await addEvidence(worksFor, orgUserId, "r3", t3, 100, "Q-r3-a");
        await addEvidence(worksFor, orgUserId, "r3", t3, 200, "Q-r3-b");
        await addEvidence(
            worksFor,
            orgUserId,
            "r3",
            t3,
            300,
            "Q-r3-stale",
            "wording_changed",
        );
        await addEvidence(ids.factLeads, ALICE, "r1", t1, 900, "Q-leads");

        const aliceTurns: TranscriptTurn[] = [
            {
                speaker: "speaker_0",
                startMs: 0,
                endMs: 4_000,
                text: "Dobrý den, tady Novák.",
            },
            {
                speaker: "speaker_1",
                startMs: 4_000,
                endMs: 9_000,
                text: "Ahoj Honzo, jak to jde s projektem Orijon?",
            },
        ];
        await insertRecording(db(), { id: "rc1", userId: ALICE });
        const rc1 = await writeTranscript(ALICE, "rc1", aliceTurns, "cs");
        const onRc1 = {
            userId: ALICE,
            transcriptionId: rc1.id,
            revision: rc1.revision,
            actorUserId: ALICE,
            orgUserId,
        };
        await acceptCorrection({
            ...onRc1,
            anchor: anchor(aliceTurns, 0, "Novák"),
            kind: "correct",
            target: { personId: ids.orgJan },
            replacement: "Novotný",
        });
        await acceptCorrection({
            ...onRc1,
            anchor: anchor(aliceTurns, 1, "Orijon"),
            kind: "correct",
            target: { entityId: ids.orion },
            replacement: "Orion",
            preTicked: true,
        });
        await acceptCorrection({
            ...onRc1,
            anchor: anchor(aliceTurns, 1, "Honzo"),
            kind: "link",
            target: { personId: ids.orgJan },
        });

        const sharedTurns: TranscriptTurn[] = [
            {
                speaker: "speaker_0",
                startMs: 0,
                endMs: 3_000,
                text: "Project Atlant ships soon.",
            },
        ];
        await insertRecording(db(), { id: "rc2", userId: BOB });
        const rc2 = await writeTranscript(BOB, "rc2", sharedTurns, "en");
        await shareRecording(db(), "rc2", orgUserId);
        await acceptCorrection({
            userId: BOB,
            transcriptionId: rc2.id,
            revision: rc2.revision,
            actorUserId: orgUserId,
            orgUserId,
            anchor: anchor(sharedTurns, 0, "Atlant"),
            kind: "correct",
            target: { entityId: ids.atlas },
            replacement: "Atlas",
        });

        const deletedTurns: TranscriptTurn[] = [
            {
                speaker: "speaker_0",
                startMs: 0,
                endMs: 3_000,
                text: "Zavolej Petr zítra.",
            },
        ];
        await insertRecording(db(), { id: "rc3", userId: ALICE });
        const rc3 = await writeTranscript(ALICE, "rc3", deletedTurns, "cs");
        await acceptCorrection({
            userId: ALICE,
            transcriptionId: rc3.id,
            revision: rc3.revision,
            actorUserId: ALICE,
            orgUserId,
            anchor: anchor(deletedTurns, 0, "Petr"),
            kind: "correct",
            target: { personId: ids.alicePetra },
            replacement: "Petra",
            preTicked: true,
        });
        await db()
            .update(recordings)
            .set({ deletedAt: new Date() })
            .where(eq(recordings.id, "rc3"));

        const bobTurns: TranscriptTurn[] = [
            {
                speaker: "speaker_0",
                startMs: 0,
                endMs: 3_000,
                text: "Karl will call.",
            },
        ];
        await insertRecording(db(), { id: "rc4", userId: BOB });
        const rc4 = await writeTranscript(BOB, "rc4", bobTurns, "en");
        await acceptCorrection({
            userId: BOB,
            transcriptionId: rc4.id,
            revision: rc4.revision,
            actorUserId: BOB,
            orgUserId,
            anchor: anchor(bobTurns, 0, "Karl"),
            kind: "correct",
            target: { personId: ids.bobKarel },
            replacement: "Karel",
            preTicked: true,
        });

        knowledgeStore().invalidateAll();
    }, 180_000);

    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    describe("list_types", () => {
        type Types = {
            entity_types: { key: string; label: string; layer: string }[];
            relation_types: {
                key: string;
                subject_types: string[];
                object_types: string[];
                object_kind: string;
            }[];
        };

        it("lists the core, Organization and the user's own types", async () => {
            const types = (await call(alice(), "list_types")) as Types;
            const layers = new Map(
                types.entity_types.map((type) => [type.key, type.layer]),
            );
            expect(layers.get("person")).toBe("core");
            expect(layers.get("organization")).toBe("core");
            expect(layers.get(orgTypeKey)).toBe("org");
            expect(layers.get(privateTypeKey)).toBe("private");
            expect(
                types.relation_types.find(
                    (relation) => relation.key === "works_for",
                ),
            ).toMatchObject({
                subject_types: ["person"],
                object_types: ["organization"],
                object_kind: "entity",
            });
        });

        it("gives a service caller the shared vocabulary alone", async () => {
            const types = (await call(service(), "list_types")) as Types;
            const keys = types.entity_types.map((type) => type.key);
            expect(keys).toContain("person");
            expect(keys).toContain(orgTypeKey);
            expect(keys).not.toContain(privateTypeKey);
            expect(
                types.entity_types.every((type) => type.layer !== "private"),
            ).toBe(true);
        });
    });

    describe("list_knowledge", () => {
        const list = async (caller: McpCaller, args: Record<string, unknown>) =>
            (await call(caller, "list_knowledge", args)) as {
                items: Item[];
                next_cursor: string | null;
            };

        it("lists exactly one type, sorted by name", async () => {
            const orgs = await list(alice(), { type: "organization" });
            expect(orgs.items).toEqual([
                {
                    id: ids.kestrel,
                    kind: "entity",
                    type: "organization",
                    name: "Kestrel Labs",
                    scope: "personal",
                },
                {
                    id: ids.lumen,
                    kind: "entity",
                    type: "organization",
                    name: "Lumen Works",
                    scope: "org",
                },
            ]);
            expect(orgs.next_cursor).toBeNull();

            const own = await list(alice(), { type: privateTypeKey });
            expect(own.items.map((item) => item.id)).toEqual([ids.hobby]);
        });

        it("lists the user's and the Organization's people, nobody else's", async () => {
            const people = await list(alice(), { type: "person" });
            const found = people.items.map((item) => item.id);
            expect(found).toContain(ids.orgJan);
            expect(found).toContain(ids.alicePetra);
            expect(found).not.toContain(ids.bobKarel);
            expect(found).not.toContain(ids.bobMartin);
            expect(people.items.every((item) => item.kind === "person")).toBe(
                true,
            );

            const personal = await list(alice(), { scope: "personal" });
            expect(
                personal.items.every((item) => item.scope === "personal"),
            ).toBe(true);
            expect(personal.items.map((item) => item.id)).toContain(ids.orion);
        });

        it("gives a service caller the Organization's alone", async () => {
            const orgs = await list(service(), { type: "organization" });
            expect(orgs.items.map((item) => item.id)).toEqual([ids.lumen]);
            const people = await list(service(), { type: "person" });
            const found = people.items.map((item) => item.id);
            expect(found).toContain(ids.orgJan);
            expect(found).not.toContain(ids.alicePetra);
            expect(found).not.toContain(ids.bobKarel);
            expect(await list(service(), { type: privateTypeKey })).toEqual({
                items: [],
                next_cursor: null,
            });
            expect(
                (await list(service(), { scope: "personal" })).items,
            ).toEqual([]);
        });

        it("pages by cursor", async () => {
            const first = await list(service(), { type: "term" });
            expect(first.items).toHaveLength(50);
            expect(first.items[0]?.name).toBe("Term 00");
            expect(first.next_cursor).toEqual(expect.any(String));
            const second = await list(service(), {
                type: "term",
                cursor: first.next_cursor,
            });
            expect(second.items.map((item) => item.name)).toEqual([
                "Term 50",
                "Term 51",
                "Term 52",
                "Term 53",
                "Term 54",
            ]);
            expect(second.next_cursor).toBeNull();
            expect(
                (
                    await failure(service(), "list_knowledge", {
                        cursor: "garbage!",
                    })
                ).message,
            ).toBe("Invalid cursor");
        });
    });

    describe("find_knowledge", () => {
        const find = async (caller: McpCaller, args: Record<string, unknown>) =>
            (await call(caller, "find_knowledge", args)) as {
                by_meaning: boolean;
                items: (Item & { reasons: string[]; score: number })[];
            };

        it("finds by names, aliases and heard-as forms the caller reads", async () => {
            const byAlias = await find(alice(), { text: "Honza" });
            expect(byAlias.by_meaning).toBe(false);
            expect(byAlias.items[0]).toMatchObject({
                id: ids.orgJan,
                kind: "person",
                type: "person",
                name: "Jan Novotný",
                scope: "org",
                reasons: [expect.any(String)],
            });
            expect(
                (await find(alice(), { text: "Novák" })).items.map(
                    (item) => item.id,
                ),
            ).toContain(ids.orgJan);
            const orion = await find(alice(), { text: "Orion" });
            expect(orion.items.map((item) => item.id)).toEqual([ids.orion]);
            expect(
                (await find(alice(), { text: "Orion", type: "person" })).items,
            ).toEqual([]);
        });

        it("gives a service caller the Organization's alone", async () => {
            expect((await find(service(), { text: "Orion" })).items).toEqual(
                [],
            );
            expect((await find(service(), { text: "Honza" })).items).toEqual(
                [],
            );
            expect(
                (await find(service(), { text: "Atlas" })).items.map(
                    (item) => item.id,
                ),
            ).toEqual([ids.atlas]);
        });
    });

    describe("get_entity", () => {
        type EntityOut = {
            id: string;
            description: string | null;
            other_names: {
                text: string;
                kind: string;
                language: string | null;
            }[];
            resolved?: unknown;
        };

        it("reads a person with aliases and heard-as forms, never private notes", async () => {
            const jan = (await call(alice(), "get_entity", {
                entity: "Jan Novotný",
            })) as EntityOut;
            expect(jan).toMatchObject({
                id: ids.orgJan,
                kind: "person",
                type: "person",
                name: "Jan Novotný",
                description: "Head of sales",
                scope: "org",
                resolved: {
                    input: "Jan Novotný",
                    id: ids.orgJan,
                    name: "Jan Novotný",
                    matched_by: "exact",
                },
            });
            expect(jan.other_names).toEqual(
                expect.arrayContaining([
                    { text: "Honza", kind: "alias", language: null },
                    { text: "Novák", kind: "heard_as", language: "cs" },
                ]),
            );
            expect(JSON.stringify(jan)).not.toContain(PRIVATE_NOTE);
            const byId = (await call(alice(), "get_entity", {
                entity: ids.orgJan,
            })) as EntityOut;
            expect(byId.resolved).toBeUndefined();
        });

        it("answers another user's private id as not found", async () => {
            for (const entity of [ids.bobKarel, ids.bobsOrion]) {
                expect(
                    (await failure(alice(), "get_entity", { entity })).outcome,
                ).toBe("not_found");
            }
        });

        it("gives a service caller the Organization's names alone", async () => {
            const jan = (await call(service(), "get_entity", {
                entity: ids.orgJan,
            })) as EntityOut;
            expect(jan.other_names).toEqual([]);
            for (const entity of [ids.alicePetra, ids.orion, "Kestrel Labs"]) {
                expect(
                    (await failure(service(), "get_entity", { entity }))
                        .outcome,
                ).toBe("not_found");
            }
            expect(
                (await call(service(), "get_entity", { entity: "Atlant" })).id,
            ).toBe(ids.atlas);
        });

        it("lists at most five visible candidates for an ambiguous name", async () => {
            const error = await failure(alice(), "get_entity", {
                entity: "Martin",
            });
            expect(error.message).toBe("Ambiguous name");
            const { candidates } = error.details as {
                candidates: { id: string; type: string }[];
            };
            expect(candidates.length).toBeGreaterThan(1);
            expect(candidates.length).toBeLessThanOrEqual(5);
            expect(candidates.map((c) => c.id)).not.toContain(ids.bobMartin);
        });
    });

    describe("get_facts", () => {
        const facts = async (
            caller: McpCaller,
            args: Record<string, unknown>,
        ) =>
            ((await call(caller, "get_facts", args)) as { facts: FactOut[] })
                .facts;

        it("names both sides, without quotes for a knowledge-only caller", async () => {
            const about = await facts(alice(), { entity: "Jan Novotný" });
            expect(about.map((fact) => fact.id).sort()).toEqual(
                [ids.factLeads, ids.factWorksFor, ids.factRole].sort(),
            );
            const leads = about.find((fact) => fact.id === ids.factLeads);
            expect(leads).toEqual({
                id: ids.factLeads,
                subject: {
                    id: ids.orgJan,
                    kind: "person",
                    name: "Jan Novotný",
                },
                relation: "leads",
                object: { id: ids.orion, kind: "entity", name: "Orion" },
                scope: "personal",
                origin: "manual",
            });
            expect(
                about.find((fact) => fact.id === ids.factRole)?.object,
            ).toEqual({ literal: "Sales lead" });
            for (const fact of about)
                expect(fact).not.toHaveProperty("evidence");
            expect(
                (
                    await facts(alice(), {
                        entity: ids.orgJan,
                        relation: "works_for",
                    })
                ).map((fact) => fact.id),
            ).toEqual([ids.factWorksFor]);
            expect(
                (await failure(alice(), "get_facts", { entity: ids.bobKarel }))
                    .outcome,
            ).toBe("not_found");
        });

        it("quotes readable recordings with transcripts:read, three at most", async () => {
            const about = await facts(
                alice(["knowledge:read", "transcripts:read"]),
                { entity: ids.orgJan },
            );
            const worksFor = about.find((fact) => fact.id === ids.factWorksFor);
            expect(worksFor?.evidence).toEqual([
                {
                    recording_id: "r4",
                    kind: "audio",
                    url: "https://riffado.example.com/dashboard?recording=r4&view=org",
                    start_ms: 500,
                    quote: "Q-r4",
                    quoted: false,
                },
                {
                    recording_id: "r1",
                    kind: "audio",
                    url: "https://riffado.example.com/dashboard?recording=r1",
                    start_ms: 100,
                    quote: "Q-r1",
                    quoted: false,
                },
                {
                    recording_id: "r3",
                    kind: "audio",
                    url: "https://riffado.example.com/dashboard?recording=r3&view=org",
                    start_ms: 100,
                    quote: "Q-r3-a",
                    quoted: false,
                },
            ]);
            expect(
                about.find((fact) => fact.id === ids.factLeads)?.evidence,
            ).toMatchObject([{ recording_id: "r1", quote: "Q-leads" }]);
            expect(
                about.find((fact) => fact.id === ids.factRole)?.evidence,
            ).toEqual([]);
            expect(JSON.stringify(about)).not.toContain("Q-r2-bob");
        });

        it("gives a service caller the Organization's facts and shared quotes", async () => {
            const plain = await facts(service(), { entity: "Jan Novotný" });
            expect(plain.map((fact) => fact.id).sort()).toEqual(
                [ids.factWorksFor, ids.factRole].sort(),
            );
            for (const fact of plain)
                expect(fact).not.toHaveProperty("evidence");

            const quoted = await facts(
                service(["knowledge:read", "transcripts:read"]),
                { entity: ids.orgJan, relation: "works_for" },
            );
            expect(quoted[0]?.evidence?.map((piece) => piece.quote)).toEqual([
                "Q-r4",
                "Q-r3-a",
                "Q-r3-b",
            ]);
        });
    });

    describe("list_mishearings", () => {
        const list = async (caller: McpCaller, args: Record<string, unknown>) =>
            (await call(caller, "list_mishearings", args)) as {
                items: MishearingOut[];
                next_cursor: string | null;
            };

        it("lists taught heard-as forms and correct corrections, without positions", async () => {
            const { items, next_cursor } = await list(alice(), {});
            expect(next_cursor).toBeNull();
            expect(items).toEqual([
                {
                    heard: "Atlant",
                    replacement: "Atlas",
                    target: {
                        id: ids.atlas,
                        kind: "entity",
                        type: "project",
                        name: "Atlas",
                    },
                    language: "en",
                    provider: "openai",
                    sources: ["heard_as", "correction"],
                },
                {
                    heard: "Novák",
                    replacement: "Novotný",
                    target: {
                        id: ids.orgJan,
                        kind: "person",
                        type: "person",
                        name: "Jan Novotný",
                    },
                    language: "cs",
                    provider: "openai",
                    sources: ["heard_as", "correction"],
                },
                {
                    heard: "Orijon",
                    replacement: "Orion",
                    target: {
                        id: ids.orion,
                        kind: "entity",
                        type: "project",
                        name: "Orion",
                    },
                    language: "cs",
                    provider: "openai",
                    sources: ["correction"],
                },
            ]);
        });

        it("filters by entity, words and language", async () => {
            const heard = async (args: Record<string, unknown>) =>
                (await list(alice(), args)).items.map((item) => item.heard);
            expect(await heard({ entity: "Atlas" })).toEqual(["Atlant"]);
            expect(await heard({ text: "novak" })).toEqual(["Novák"]);
            expect(await heard({ language: "cs" })).toEqual([
                "Novák",
                "Orijon",
            ]);
            expect(await heard({ language: "en-US" })).toEqual(["Atlant"]);
            const filtered = await list(alice(), { entity: "Jan Novotný" });
            expect(filtered).toMatchObject({
                resolved: { id: ids.orgJan, matched_by: "exact" },
            });
        });

        it("counts reading the correction libraries as a search", async () => {
            allowScan.mockClear();
            await list(alice(), {});
            expect(allowScan).toHaveBeenCalledTimes(1);
            allowScan.mockResolvedValueOnce(false);
            expect(
                await failure(alice(), "list_mishearings", {}),
            ).toMatchObject({
                message: "Too many searches; retry in a minute",
                outcome: "denied",
            });
        });

        it("pages a vocabulary 200 at a time", async () => {
            const bob = userCaller(
                BOB,
                "bob@example.test",
                ["knowledge:read"],
                orgUserId,
            );
            await insertRecording(db(), { id: "rc-vocabulary", userId: BOB });
            const transcriptionId = await insertTranscript(
                db(),
                "rc-vocabulary",
                BOB,
            );
            await db()
                .insert(transcriptCorrections)
                .values(
                    Array.from({ length: 120 }, (_, index) => {
                        const heard = `Orijon ${String(index).padStart(3, "0")}`;
                        return {
                            userId: BOB,
                            transcriptionId,
                            transcriptRevision: 0,
                            turnIndex: 0,
                            charStart: index * 10,
                            charEnd: index * 10 + 5,
                            heard: encryptText(heard),
                            heardHmac: domainLookupHash(
                                "correction-heard",
                                heard,
                            ),
                            kind: "correct" as const,
                            targetEntityId: ids.bobsOrion,
                            replacement: encryptText("Orion"),
                        };
                    }),
                );
            knowledgeStore().invalidateAll();
            const { items, next_cursor } = await list(bob, {
                text: "orijon",
            });
            expect(items).toHaveLength(120);
            expect(next_cursor).toBeNull();
        });

        it("gives a service caller the Organization's library alone", async () => {
            const { items } = await list(service(), {});
            expect(items.map((item) => item.heard)).toEqual(["Atlant"]);
            expect(
                (
                    await failure(service(), "list_mishearings", {
                        entity: "Orion",
                    })
                ).outcome,
            ).toBe("not_found");
        });
    });

    describe("over MCP", () => {
        async function connect(caller: McpCaller) {
            const server = buildMcpServer(KNOWLEDGE_TOOLS, caller, null);
            const [clientSide, serverSide] =
                InMemoryTransport.createLinkedPair();
            await server.connect(serverSide);
            const client = new Client({ name: "test", version: "1" });
            await client.connect(clientSide);
            return {
                client,
                close: async () => {
                    await client.close();
                    await server.close();
                },
            };
        }

        it("lists the knowledge tools and answers within their schemas", async () => {
            const session = await connect(
                service(["knowledge:read", "transcripts:read"]),
            );
            try {
                const { tools } = await session.client.listTools();
                expect(tools.map((listed) => listed.name)).toEqual([
                    "list_types",
                    "list_knowledge",
                    "find_knowledge",
                    "get_entity",
                    "get_facts",
                    "list_mishearings",
                ]);
                for (const [name, args] of [
                    ["list_types", {}],
                    ["list_knowledge", { type: "organization" }],
                    ["find_knowledge", { text: "Atlas" }],
                    ["get_entity", { entity: "Jan Novotný" }],
                    ["get_facts", { entity: ids.orgJan }],
                    ["list_mishearings", {}],
                ] as const) {
                    const result = (await session.client.callTool({
                        name,
                        arguments: args,
                    })) as CallToolResult;
                    expect(result.isError, name).toBeFalsy();
                    expect(result.structuredContent, name).toBeDefined();
                }
                const facts = (await session.client.callTool({
                    name: "get_facts",
                    arguments: { entity: ids.orgJan, relation: "works_for" },
                })) as CallToolResult;
                expect(
                    (facts.structuredContent as { facts: FactOut[] }).facts[0]
                        ?.evidence,
                ).toHaveLength(3);

                const ambiguous = (await session.client.callTool({
                    name: "get_entity",
                    arguments: { entity: "Martin" },
                })) as CallToolResult;
                expect(ambiguous.isError).toBe(true);
                const [first] = ambiguous.content;
                expect(first?.type === "text" ? first.text : "").toContain(
                    "Ambiguous name",
                );
            } finally {
                await session.close();
            }
        });

        it("hides the tools from a caller without knowledge:read", async () => {
            const session = await connect(alice(["transcripts:read"]));
            try {
                expect((await session.client.listTools()).tools).toEqual([]);
            } finally {
                await session.close();
            }
        });
    });
});
