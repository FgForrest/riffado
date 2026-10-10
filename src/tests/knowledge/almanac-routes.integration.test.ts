/**
 * Editing the Almanac through its routes against a real PostgreSQL: things,
 * nicknames, facts typed by hand and a pasted import, each for the owner, a
 * member facing the Organization's records, and another member.
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
    knowledgeAliases,
    knowledgeFacts,
    transcriptCorrections,
    transcriptions,
    users,
} from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

// Runs once right after the route reads the thing it names, to merge that
// thing away before the route's own merge.
const afterRead = vi.hoisted(() => ({
    current: null as null | {
        id: string;
        run: () => Promise<void>;
    },
}));

const { dbProxy, dbRef, mockEnv } = vi.hoisted(() => {
    const ref: { current: Record<PropertyKey, unknown> | null } = {
        current: null,
    };
    const proxy = new Proxy(
        {},
        {
            get: (_target, property: string | symbol) => {
                const current = ref.current;
                if (!current)
                    throw new Error("test database was not initialized");
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
            ORG_ACCOUNT_PASSWORD: "organization-password" as string | undefined,
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
vi.mock("@/lib/knowledge/entities", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@/lib/knowledge/entities")>();
    return {
        ...actual,
        getEntity: async (
            ...args: Parameters<typeof actual.getEntity>
        ): ReturnType<typeof actual.getEntity> => {
            const found = await actual.getEntity(...args);
            const hook = afterRead.current;
            if (hook && hook.id === args[1]) {
                afterRead.current = null;
                await hook.run();
            }
            return found;
        },
    };
});
vi.mock("@/lib/auth-server", async () => {
    const { AppError, ErrorCode } =
        await vi.importActual<typeof import("@/lib/errors")>("@/lib/errors");
    return {
        requireApiSession: vi.fn(async (request: Request) => {
            const id = request.headers.get("x-test-user");
            if (!id) {
                throw new AppError(
                    ErrorCode.AUTH_SESSION_MISSING,
                    "Unauthorized",
                    401,
                );
            }
            return { user: { id, email: `${id}@example.test` } };
        }),
    };
});

import { DELETE as deleteAliasRoute } from "@/app/api/knowledge/aliases/[id]/route";
import { POST as postAliasRoute } from "@/app/api/knowledge/aliases/route";
import {
    DELETE as deleteEntityRoute,
    POST as mergeEntityRoute,
    PATCH as patchEntityRoute,
} from "@/app/api/knowledge/entities/[id]/route";
import {
    GET as listEntitiesRoute,
    POST as postEntityRoute,
} from "@/app/api/knowledge/entities/route";
import {
    DELETE as deleteFactRoute,
    PUT as putFactRoute,
} from "@/app/api/knowledge/facts/[id]/route";
import { POST as postFactRoute } from "@/app/api/knowledge/facts/route";
import { POST as importRoute } from "@/app/api/knowledge/import/route";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import {
    addAlias,
    aliasTextsVisibleTo,
    listAliases,
} from "@/lib/knowledge/aliases";
import {
    createEntity,
    getEntity,
    mergeEntities,
} from "@/lib/knowledge/entities";
import { confirmManualFact, listFacts } from "@/lib/knowledge/facts";
import { knowledgeStore } from "@/lib/knowledge/knowledge-loader";
import { createPerson, listPeople } from "@/lib/knowledge/people";
import { seedCoreVocabulary } from "@/lib/knowledge/vocabulary";
import { ensureOrgAccount } from "@/lib/org/account";
import { insertRecordings } from "@/tests/integration/items";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const OWNER = "user-owner";
const OTHER = "user-other";

type Handler = (
    request: Request,
    context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/** Call a route as `user`; its status and JSON body. */
async function call(
    handler: unknown,
    user: string,
    method: string,
    body?: unknown,
    params: Record<string, string> = {},
    query = "",
) {
    const response = await (handler as Handler)(
        new Request(`http://localhost/api/test${query}`, {
            method,
            headers: {
                "x-test-user": user,
                ...(body === undefined
                    ? {}
                    : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
        { params: Promise.resolve(params) },
    );
    return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown> & {
            details?: Record<string, unknown>;
        },
    };
}

describeWithDatabase("editing the Almanac (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;
    let orgUserId = "";
    const db = () => {
        if (!database) throw new Error("no db");
        return database.db;
    };

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "almanac_routes",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
    }, 120_000);
    afterAll(async () => {
        dbRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        mockEnv.ORG_ACCOUNT_PASSWORD = "organization-password";
        knowledgeStore().invalidateAll();
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: OWNER, email: "o@example.test" },
                { id: OTHER, email: "x@example.test" },
            ]);
        orgUserId = (await ensureOrgAccount()) ?? "";
        await seedCoreVocabulary();
    });

    describe("things", () => {
        it("adds a thing with its nicknames, and refuses a second of that name and type", async () => {
            const created = await call(postEntityRoute, OWNER, "POST", {
                typeKey: "product",
                name: "Orion",
                description: "The billing system",
                nicknames: ["Orión", "ORN", "Orión"],
            });
            expect(created.status).toBe(201);
            const id = (created.body.entity as { id: string }).id;
            expect(
                (await listAliases(OWNER, { entityId: id }))
                    .map((alias) => alias.text)
                    .sort(),
            ).toEqual(["ORN", "Orión"]);
            // The Things list searches them; nobody else sees them.
            expect(
                (await aliasTextsVisibleTo(OWNER, "entity")).get(id)?.sort(),
            ).toEqual(["ORN", "Orión"]);
            expect((await aliasTextsVisibleTo(OTHER, "entity")).has(id)).toBe(
                false,
            );

            // The same name in another case and spacing is the same name.
            const same = await call(postEntityRoute, OWNER, "POST", {
                typeKey: "product",
                name: " orion ",
            });
            expect(same.status).toBe(409);
            expect(same.body.details?.existingId).toBe(id);
            // Another type may have it.
            expect(
                (
                    await call(postEntityRoute, OWNER, "POST", {
                        typeKey: "project",
                        name: "Orion",
                    })
                ).status,
            ).toBe(201);

            const listed = await call(
                listEntitiesRoute,
                OWNER,
                "GET",
                undefined,
                {},
                "?typeKey=product",
            );
            expect(
                (listed.body.entities as { id: string }[]).map(
                    (entity) => entity.id,
                ),
            ).toContain(id);
            // Nobody else sees a private thing.
            expect(
                (await call(listEntitiesRoute, OTHER, "GET")).body.entities,
            ).toEqual([]);
        });

        it("renames, retypes, merges and erases the owner's own things", async () => {
            const orion = await createEntity(OWNER, {
                typeKey: "product",
                name: "Orion",
            });
            const dupe = await createEntity(OWNER, {
                typeKey: "project",
                name: "Orion project",
            });
            const renamed = await call(
                patchEntityRoute,
                OWNER,
                "PATCH",
                { name: "Orion 2" },
                { id: orion.id },
            );
            expect(renamed.body.entity).toMatchObject({ name: "Orion 2" });
            expect(
                (
                    await call(
                        patchEntityRoute,
                        OWNER,
                        "PATCH",
                        { typeKey: "project" },
                        { id: orion.id },
                    )
                ).body.entity,
            ).toMatchObject({ typeKey: "project" });
            const merged = await call(
                mergeEntityRoute,
                OWNER,
                "POST",
                { mergeIntoId: dupe.id },
                { id: orion.id },
            );
            expect(merged.body.entity).toMatchObject({ id: dupe.id });
            expect((await getEntity(OWNER, orion.id))?.mergedIntoId).toBe(
                dupe.id,
            );
            expect(
                (
                    await call(deleteEntityRoute, OWNER, "DELETE", undefined, {
                        id: dupe.id,
                    })
                ).status,
            ).toBe(200);
            expect(await getEntity(OWNER, dupe.id)).toBeNull();
        });

        it("reports the winner when the target is merged away after it was read", async () => {
            const [target, winner, loser] = await Promise.all(
                ["Target", "Winner", "Loser"].map((name) =>
                    createEntity(OWNER, { typeKey: "project", name }),
                ),
            );
            afterRead.current = {
                id: target.id,
                run: () => mergeEntities(OWNER, winner.id, target.id),
            };
            const merged = await call(
                mergeEntityRoute,
                OWNER,
                "POST",
                { mergeIntoId: target.id },
                { id: loser.id },
            );
            expect(afterRead.current).toBeNull();
            expect(merged.body.entity).toMatchObject({ id: winner.id });
            expect((await getEntity(OWNER, loser.id))?.mergedIntoId).toBe(
                winner.id,
            );
        });

        it("keeps a type change from breaking a fact, and names the fact", async () => {
            const jan = await createPerson({
                userId: OWNER,
                displayName: "Jan Novotný",
            });
            const orion = await createEntity(OWNER, {
                typeKey: "project",
                name: "Orion",
            });
            const fact = await call(postFactRoute, OWNER, "POST", {
                subject: { personId: jan.id },
                relationKey: "leads",
                object: { entityId: orion.id },
            });
            expect(fact.status).toBe(201);
            // Nobody leads a term.
            const retyped = await call(
                patchEntityRoute,
                OWNER,
                "PATCH",
                { typeKey: "term" },
                { id: orion.id },
            );
            expect(retyped.status).toBe(409);
            expect(retyped.body.details).toMatchObject({
                factId: fact.body.id,
                relationKey: "leads",
            });
            expect((await getEntity(OWNER, orion.id))?.typeKey).toBe("project");
        });

        it("blocks a type change only on the changer's own current facts", async () => {
            const jan = await createPerson({
                userId: OWNER,
                displayName: "Jan Novotný",
            });
            const orion = await createEntity(orgUserId, {
                typeKey: "project",
                name: "Orion",
            });
            // A member's own fact the Organization cannot see or fix.
            await confirmManualFact(OWNER, {
                subject: { personId: jan.id },
                relationKey: "leads",
                object: { entityId: orion.id },
            });
            const retyped = await call(
                patchEntityRoute,
                orgUserId,
                "PATCH",
                { typeKey: "term" },
                { id: orion.id },
            );
            expect(retyped.status).toBe(200);
            expect(retyped.body.entity).toMatchObject({ typeKey: "term" });
        });

        it("changes name and type together or not at all", async () => {
            const orion = await createEntity(OWNER, {
                typeKey: "product",
                name: "Orion",
            });
            await createEntity(OWNER, { typeKey: "project", name: "Atlas" });
            const refused = await call(
                patchEntityRoute,
                OWNER,
                "PATCH",
                { name: "Atlas", typeKey: "project" },
                { id: orion.id },
            );
            expect(refused.status).toBe(409);
            expect(await getEntity(OWNER, orion.id)).toMatchObject({
                name: "Orion",
                typeKey: "product",
            });
        });

        it("plans again the exports of the transcript's owner when an Organization thing is renamed", async () => {
            const acme = await createEntity(orgUserId, {
                typeKey: "organization",
                name: "Acme",
            });
            await insertRecordings(db(), {
                id: "rec-1",
                userId: OWNER,
                deviceSn: "SN-1",
                plaudFileId: "plaud-1",
                filename: encryptText("Weekly"),
                duration: 10_000,
                startTime: new Date("2026-09-01T10:00:00Z"),
                endTime: new Date("2026-09-01T10:00:10Z"),
                filesize: 11,
                fileMd5: "0".repeat(32),
                storageType: "local",
                storagePath: `${OWNER}/rec.mp3`,
                plaudVersion: "1",
            });
            const [transcript] = await db()
                .insert(transcriptions)
                .values({
                    recordingId: "rec-1",
                    userId: OWNER,
                    text: encryptText("Akme"),
                    turns: encryptJsonField([
                        {
                            speaker: "speaker_0",
                            startMs: 0,
                            endMs: 1000,
                            text: "Akme",
                        },
                    ]),
                    provider: "openai",
                    model: "gpt-4o-transcribe-diarize",
                    source: "riffado",
                })
                .returning({ id: transcriptions.id });
            // Linked in the Organization's scope, on the owner's transcript.
            await db()
                .insert(transcriptCorrections)
                .values({
                    userId: orgUserId,
                    transcriptionId: transcript?.id ?? "",
                    transcriptRevision: 0,
                    turnIndex: 0,
                    charStart: 0,
                    charEnd: 4,
                    heard: encryptText("Akme"),
                    heardHmac: "h",
                    kind: "link",
                    targetEntityId: acme.id,
                });
            vi.mocked(enqueueExportPlansForUser).mockClear();
            await call(
                patchEntityRoute,
                orgUserId,
                "PATCH",
                { name: "Acme Inc" },
                { id: acme.id },
            );
            expect(
                vi
                    .mocked(enqueueExportPlansForUser)
                    .mock.calls.map(([userId]) => userId)
                    .sort(),
            ).toEqual([orgUserId, OWNER].sort());
        });

        it("keeps the Organization's things to its account; a member's words become their notes", async () => {
            const shared = await createEntity(orgUserId, {
                typeKey: "organization",
                name: "Acme",
            });
            const rename = await call(
                patchEntityRoute,
                OWNER,
                "PATCH",
                { name: "Acme Inc" },
                { id: shared.id },
            );
            expect(rename.status).toBe(403);
            for (const [handler, method, body] of [
                [mergeEntityRoute, "POST", { mergeIntoId: shared.id }],
                [deleteEntityRoute, "DELETE", undefined],
            ] as const) {
                const own = await createEntity(OWNER, {
                    typeKey: "organization",
                    name: `Acme ${method}`,
                });
                if (method === "DELETE") {
                    expect(
                        (
                            await call(handler, OWNER, method, body, {
                                id: shared.id,
                            })
                        ).status,
                    ).toBe(403);
                } else {
                    // A private duplicate folds into the shared record.
                    expect(
                        (
                            await call(handler, OWNER, method, body, {
                                id: own.id,
                            })
                        ).status,
                    ).toBe(200);
                }
            }
            const noted = await call(
                patchEntityRoute,
                OWNER,
                "PATCH",
                { description: "Our biggest client" },
                { id: shared.id },
            );
            expect(noted.body.entity).toMatchObject({
                description: null,
                notes: "Our biggest client",
            });
            // Another member's private thing is not there at all.
            const mine = await createEntity(OWNER, {
                typeKey: "term",
                name: "SLA",
            });
            expect(
                (
                    await call(
                        patchEntityRoute,
                        OTHER,
                        "PATCH",
                        { name: "x" },
                        { id: mine.id },
                    )
                ).status,
            ).toBe(404);
        });

        it("changes nothing of the Organization's while its scope is read-only", async () => {
            const shared = await createEntity(orgUserId, {
                typeKey: "organization",
                name: "Acme",
            });
            mockEnv.ORG_ACCOUNT_PASSWORD = undefined;
            for (const response of [
                await call(postEntityRoute, orgUserId, "POST", {
                    typeKey: "product",
                    name: "Orion",
                }),
                await call(
                    patchEntityRoute,
                    orgUserId,
                    "PATCH",
                    { name: "Acme Inc" },
                    { id: shared.id },
                ),
                await call(postAliasRoute, orgUserId, "POST", {
                    target: { entityId: shared.id },
                    text: "ACM",
                }),
            ]) {
                expect(response.status).toBe(403);
            }
            // A member's own knowledge is theirs to change still.
            expect(
                (
                    await call(postEntityRoute, OWNER, "POST", {
                        typeKey: "product",
                        name: "Orion",
                    })
                ).status,
            ).toBe(201);
        });
    });

    describe("nicknames", () => {
        it("adds and takes back the caller's own nicknames only", async () => {
            const jan = await createPerson({
                userId: OWNER,
                displayName: "Jan Novotný",
            });
            const added = await call(postAliasRoute, OWNER, "POST", {
                target: { personId: jan.id },
                text: "Honza",
            });
            expect(added.status).toBe(201);
            expect(
                (
                    await call(postAliasRoute, OWNER, "POST", {
                        target: { personId: jan.id },
                        text: "Honza",
                    })
                ).status,
            ).toBe(409);
            // Someone else's person is not there to name.
            expect(
                (
                    await call(postAliasRoute, OTHER, "POST", {
                        target: { personId: jan.id },
                        text: "Jeník",
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(deleteAliasRoute, OTHER, "DELETE", undefined, {
                        id: added.body.id as string,
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(deleteAliasRoute, OWNER, "DELETE", undefined, {
                        id: added.body.id as string,
                    })
                ).status,
            ).toBe(200);
            expect(await db().select().from(knowledgeAliases)).toEqual([]);
        });

        it("searches a member's own nicknames and the Organization's, each once", async () => {
            const acme = await createEntity(orgUserId, {
                typeKey: "organization",
                name: "Acme",
            });
            await addAlias(orgUserId, { entityId: acme.id }, "Akme");
            await addAlias(OWNER, { entityId: acme.id }, "Akme");
            await addAlias(OWNER, { entityId: acme.id }, "Ajkme");
            await addAlias(OTHER, { entityId: acme.id }, "Ejkm");
            expect(
                (await aliasTextsVisibleTo(OWNER, "entity"))
                    .get(acme.id)
                    ?.sort(),
            ).toEqual(["Ajkme", "Akme"]);
            expect(
                (await aliasTextsVisibleTo(OTHER, "entity"))
                    .get(acme.id)
                    ?.sort(),
            ).toEqual(["Akme", "Ejkm"]);
            expect((await aliasTextsVisibleTo(OWNER, "person")).size).toBe(0);
        });
    });

    describe("facts by hand", () => {
        it("asks before replacing the one value a relation holds, then replaces it", async () => {
            const jan = await createPerson({
                userId: OWNER,
                displayName: "Jan Novotný",
            });
            const acme = await createEntity(OWNER, {
                typeKey: "organization",
                name: "Acme",
            });
            const tavesi = await createEntity(OWNER, {
                typeKey: "organization",
                name: "Tavesi",
            });
            const first = await call(postFactRoute, OWNER, "POST", {
                subject: { personId: jan.id },
                relationKey: "works_for",
                object: { entityId: acme.id },
            });
            expect(first.status).toBe(201);
            const second = await call(postFactRoute, OWNER, "POST", {
                subject: { personId: jan.id },
                relationKey: "works_for",
                object: { entityId: tavesi.id },
            });
            expect(second.status).toBe(409);
            expect(second.body.details?.currentFactId).toBe(first.body.id);
            const replaced = await call(postFactRoute, OWNER, "POST", {
                subject: { personId: jan.id },
                relationKey: "works_for",
                object: { entityId: tavesi.id },
                expectedCurrentFactId: first.body.id,
            });
            expect(replaced.status).toBe(201);
            expect(
                (await listFacts(OWNER, { personId: jan.id })).map(
                    (fact) => fact.object,
                ),
            ).toEqual([{ entityId: tavesi.id }]);
        });

        it("changes what a fact says in place of it, and erases it", async () => {
            const jan = await createPerson({
                userId: OWNER,
                displayName: "Jan Novotný",
            });
            const role = await call(postFactRoute, OWNER, "POST", {
                subject: { personId: jan.id },
                relationKey: "has_role",
                object: { literal: "tester" },
            });
            const changed = await call(
                putFactRoute,
                OWNER,
                "PUT",
                { object: { literal: "product owner" } },
                { id: role.body.id as string },
            );
            expect(changed.status).toBe(200);
            const facts = await listFacts(OWNER, { personId: jan.id });
            expect(facts.map((fact) => fact.object)).toEqual([
                { literal: "product owner" },
            ]);
            expect(
                await db()
                    .select({ id: knowledgeFacts.id })
                    .from(knowledgeFacts)
                    .where(eq(knowledgeFacts.id, role.body.id as string)),
            ).toEqual([]);
            // Nobody else changes or erases it.
            const factId = facts[0]?.id ?? "";
            for (const response of [
                await call(
                    putFactRoute,
                    OTHER,
                    "PUT",
                    { object: { literal: "x" } },
                    { id: factId },
                ),
                await call(deleteFactRoute, OTHER, "DELETE", undefined, {
                    id: factId,
                }),
            ]) {
                expect(response.status).toBe(404);
            }
            expect(
                (
                    await call(deleteFactRoute, OWNER, "DELETE", undefined, {
                        id: factId,
                    })
                ).status,
            ).toBe(200);
            expect(await listFacts(OWNER, { personId: jan.id })).toEqual([]);
        });

        it("refuses text about a person on a denied topic, but not what a term means", async () => {
            const jan = await createPerson({
                userId: OWNER,
                displayName: "Jan Novotný",
            });
            const kpi = await createEntity(OWNER, {
                typeKey: "term",
                name: "KPI",
            });
            const refused = await call(postFactRoute, OWNER, "POST", {
                subject: { personId: jan.id },
                relationKey: "has_role",
                object: { literal: "on sick leave" },
            });
            expect(refused.status).toBe(400);
            expect(refused.body.details).toMatchObject({ field: "object" });
            const role = await call(postFactRoute, OWNER, "POST", {
                subject: { personId: jan.id },
                relationKey: "has_role",
                object: { literal: "tester" },
            });
            expect(
                (
                    await call(
                        putFactRoute,
                        OWNER,
                        "PUT",
                        { object: { literal: "divorce lawyer" } },
                        { id: role.body.id as string },
                    )
                ).status,
            ).toBe(400);
            expect(
                (
                    await call(postFactRoute, OWNER, "POST", {
                        subject: { entityId: kpi.id },
                        relationKey: "means",
                        object: { literal: "Key Performance Indicator" },
                    })
                ).status,
            ).toBe(201);
        });
    });

    describe("import", () => {
        const LIST = [
            "# the team's things",
            "product: Orion (ORN, Orión), Atlas",
            "Organizace: Acme; Tavesi (Tavesy)",
            "osoba: Jana Nováková (Janička)",
            "product: Orion",
            "planet: Mars",
            "nonsense line",
        ].join("\n");

        it("previews what each name would do, and writes nothing", async () => {
            await createEntity(orgUserId, {
                typeKey: "organization",
                name: "Acme",
            });
            const preview = await call(importRoute, OWNER, "POST", {
                text: LIST,
            });
            expect(preview.status).toBe(200);
            const rows = preview.body.rows as {
                name: string;
                typeKey: string | null;
                status: string;
            }[];
            expect(
                rows.map((row) => [row.name, row.typeKey, row.status]),
            ).toEqual([
                ["Orion", "product", "create"],
                ["Atlas", "product", "create"],
                // The Organization's record is the one it means.
                ["Acme", "organization", "exists"],
                ["Tavesi", "organization", "create"],
                ["Jana Nováková", "person", "create"],
                ["Orion", "product", "exists"],
                ["Mars", null, "unknown_type"],
            ]);
            expect(preview.body.problems).toEqual([
                { line: 7, text: "nonsense line" },
            ]);
            expect(preview.body.applied).toBe(false);
            expect(
                (await call(listEntitiesRoute, OWNER, "GET")).body.entities,
            ).toHaveLength(1);
        });

        it("applies two imports at once one after the other, creating each name once", async () => {
            const text = "person: Jana Nováková (Janička)\nproduct: Orion";
            const [first, second] = await Promise.all([
                call(importRoute, OWNER, "POST", { text, dryRun: false }),
                call(importRoute, OWNER, "POST", { text, dryRun: false }),
            ]);
            expect([first.status, second.status]).toEqual([200, 200]);
            expect([first.body.created, second.body.created].sort()).toEqual([
                0, 2,
            ]);
            expect(
                (await listPeople(OWNER)).filter(
                    (person) => person.displayName === "Jana Nováková",
                ),
            ).toHaveLength(1);
        });

        it("gives no nickname to one of two people of the same name", async () => {
            await createPerson({ userId: OWNER, displayName: "Alex Kim" });
            await createPerson({ userId: OWNER, displayName: "alex kim" });
            const applied = await call(importRoute, OWNER, "POST", {
                text: "person: Alex Kim (CEO)",
                dryRun: false,
            });
            expect(applied.body).toMatchObject({
                created: 0,
                nicknamesAdded: 0,
                rows: [{ name: "Alex Kim", status: "ambiguous" }],
            });
            expect(await db().select().from(knowledgeAliases)).toEqual([]);
        });

        it("previews what it then does, names in another case the same", async () => {
            const text = "product: Beta, beta, Béta";
            const preview = await call(importRoute, OWNER, "POST", { text });
            expect(
                (preview.body.rows as { status: string }[]).map(
                    (row) => row.status,
                ),
            ).toEqual(["create", "exists", "create"]);
            expect(
                (
                    await call(importRoute, OWNER, "POST", {
                        text,
                        dryRun: false,
                    })
                ).body,
            ).toMatchObject({ created: 2 });
        });

        it("creates each name once and gives its nicknames, in the caller's scope", async () => {
            const applied = await call(importRoute, OWNER, "POST", {
                text: LIST,
                dryRun: false,
            });
            expect(applied.body).toMatchObject({
                applied: true,
                created: 5,
                nicknamesAdded: 4,
            });
            const things = (await call(listEntitiesRoute, OWNER, "GET")).body
                .entities as { id: string; name: string; scope: string }[];
            expect(things.map((thing) => thing.name).sort()).toEqual([
                "Acme",
                "Atlas",
                "Orion",
                "Tavesi",
            ]);
            expect(things.every((thing) => thing.scope === "personal")).toBe(
                true,
            );
            const jana = (await listPeople(OWNER)).find(
                (person) => person.displayName === "Jana Nováková",
            );
            expect(
                (await listAliases(OWNER, { personId: jana?.id ?? "" })).map(
                    (alias) => alias.text,
                ),
            ).toEqual(["Janička"]);
            // Again: nothing new, nothing twice.
            expect(
                (
                    await call(importRoute, OWNER, "POST", {
                        text: LIST,
                        dryRun: false,
                    })
                ).body,
            ).toMatchObject({ created: 0, nicknamesAdded: 0 });
        });
    });
});
