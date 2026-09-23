/**
 * The Google connection against a real PostgreSQL: storing an account,
 * refreshing its token, losing it, and the OAuth callback that creates it.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a PostgreSQL the harness may
 * create scratch databases on.
 */

import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { oauthConnections, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const { dbProxy, sqlProxy, dbRef, sqlRef, mockEnv, enqueuePlans } = vi.hoisted(
    () => {
        function lazy(ref: { current: Record<PropertyKey, unknown> | null }) {
            return new Proxy(
                {},
                {
                    get: (_target, property: string | symbol) => {
                        const current = ref.current;
                        if (!current) {
                            throw new Error(
                                "test database was not initialized",
                            );
                        }
                        const value = current[property];
                        return typeof value === "function"
                            ? value.bind(current)
                            : value;
                    },
                },
            );
        }
        const dbRef: { current: Record<PropertyKey, unknown> | null } = {
            current: null,
        };
        const sqlRef: { current: Record<PropertyKey, unknown> | null } = {
            current: null,
        };
        return {
            dbProxy: lazy(dbRef),
            sqlProxy: lazy(sqlRef),
            dbRef,
            sqlRef,
            enqueuePlans: vi.fn(async () => {}),
            mockEnv: {
                IS_HOSTED: false,
                APP_URL: "https://riffado.example",
                GOOGLE_CLIENT_ID: "client" as string | undefined,
                GOOGLE_CLIENT_SECRET: "secret",
                GOOGLE_PICKER_API_KEY: "picker",
                GOOGLE_CLOUD_PROJECT_NUMBER: "1234",
                GOOGLE_WORKSPACE_DOMAINS: [] as string[],
                ENCRYPTION_KEY:
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                DATABASE_URL: "postgres://unused",
            },
        };
    },
);

vi.mock("@/db", () => ({ db: dbProxy, sqlClient: sqlProxy }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn().mockResolvedValue(undefined),
    captureServerException: vi.fn(),
}));
vi.mock("@/lib/jobs/nudge", () => ({ nudge: vi.fn() }));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: enqueuePlans,
}));

import { decryptText } from "@/lib/encryption/fields";
import {
    completeGoogleConnect,
    returnUrlWithOutcome,
} from "@/lib/integrations/google/connect-flow";
import {
    __resetGoogleAccessTokensForTests,
    disconnectGoogle,
    getGoogleAccessToken,
    getGoogleConnectionStatus,
    saveGoogleConnection,
} from "@/lib/integrations/google/connection";
import { GoogleConnectionUnavailableError } from "@/lib/integrations/google/errors";
import { sealGoogleOAuthState } from "@/lib/integrations/google/oauth-state";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const USER = "user-google";
const OTHER = "user-other";
const DRIVE_SCOPES = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/drive.file",
];

function claims(
    subject = "sub-1",
    hostedDomain: string | null = "example.com",
) {
    return {
        subject,
        email: `${subject}@example.com`,
        emailVerified: true,
        hostedDomain,
    };
}

function tokens(refreshToken: string | null = "refresh-1") {
    return {
        accessToken: "access-1",
        expiresInSeconds: 3600,
        refreshToken,
        scopes: DRIVE_SCOPES,
        idToken: null,
    };
}

function idToken(values: Record<string, unknown>): string {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none" })}.${encode(values)}.sig`;
}

function tokenEndpoint(body: Record<string, unknown>, status = 200) {
    return vi.fn(
        async () => new Response(JSON.stringify(body), { status }),
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describeWithDatabase("Google connection (PostgreSQL)", () => {
    let database: TestPostgresDatabase | null = null;

    function db() {
        if (!database) throw new Error("test database was not initialized");
        return database.db;
    }

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "google_connection",
        );
        dbRef.current = database.db as unknown as Record<PropertyKey, unknown>;
        sqlRef.current = database.sql as unknown as Record<
            PropertyKey,
            unknown
        >;
    }, 120_000);

    afterAll(async () => {
        dbRef.current = null;
        sqlRef.current = null;
        await database?.dispose();
    }, 30_000);

    beforeEach(async () => {
        __resetGoogleAccessTokensForTests();
        enqueuePlans.mockClear();
        mockEnv.GOOGLE_CLIENT_ID = "client";
        mockEnv.IS_HOSTED = false;
        mockEnv.GOOGLE_WORKSPACE_DOMAINS = [];
        await db().delete(users);
        await db()
            .insert(users)
            .values([
                { id: USER, email: "user@example.com" },
                { id: OTHER, email: "other@example.com" },
            ]);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe("access tokens", () => {
        it("refreshes once and serves the cached token after", async () => {
            await saveGoogleConnection(USER, claims(), tokens());
            __resetGoogleAccessTokensForTests();
            const fetchImpl = tokenEndpoint({
                access_token: "fresh",
                expires_in: 3600,
                refresh_token: "rotated",
            });
            await expect(
                getGoogleAccessToken(USER, { fetchImpl }),
            ).resolves.toBe("fresh");
            await expect(
                getGoogleAccessToken(USER, { fetchImpl }),
            ).resolves.toBe("fresh");
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            const sent = new URLSearchParams(
                String(fetchImpl.mock.calls[0]?.[1]?.body),
            );
            expect(sent.get("refresh_token")).toBe("refresh-1");
            const [row] = await db().select().from(oauthConnections);
            expect(decryptText(row?.refreshToken ?? "")).toBe("rotated");
        });

        it("marks a revoked grant for reconnecting and stops asking Google", async () => {
            await saveGoogleConnection(USER, claims(), tokens());
            __resetGoogleAccessTokensForTests();
            const fetchImpl = tokenEndpoint(
                {
                    error: "invalid_grant",
                    error_description: "Token has been expired or revoked.",
                },
                400,
            );
            await expect(
                getGoogleAccessToken(USER, { fetchImpl }),
            ).rejects.toMatchObject({ problem: "needs_reconnect" });
            expect(await getGoogleConnectionStatus(USER)).toMatchObject({
                status: "needs_reconnect",
            });
            await expect(
                getGoogleAccessToken(USER, { fetchImpl }),
            ).rejects.toBeInstanceOf(GoogleConnectionUnavailableError);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            await saveGoogleConnection(USER, claims(), tokens());
            expect(await getGoogleConnectionStatus(USER)).toMatchObject({
                status: "active",
            });
        });

        it("refuses another account, no account, and a disabled integration", async () => {
            await expect(getGoogleAccessToken(USER)).rejects.toMatchObject({
                problem: "not_connected",
            });
            await saveGoogleConnection(USER, claims(), tokens());
            await expect(
                getGoogleAccessToken(USER, { expectedSubject: "sub-9" }),
            ).rejects.toMatchObject({ problem: "account_mismatch" });
            await expect(
                getGoogleAccessToken(USER, { expectedSubject: "sub-1" }),
            ).resolves.toBe("access-1");
            mockEnv.IS_HOSTED = true;
            await expect(getGoogleAccessToken(USER)).rejects.toMatchObject({
                problem: "not_configured",
            });
            mockEnv.IS_HOSTED = false;
            mockEnv.GOOGLE_CLIENT_ID = undefined;
            await expect(getGoogleAccessToken(USER)).rejects.toMatchObject({
                problem: "not_configured",
            });
        });
    });

    describe("storing accounts", () => {
        it("keeps the refresh token when Google omits it for the same account", async () => {
            await saveGoogleConnection(USER, claims(), tokens("refresh-1"));
            await saveGoogleConnection(USER, claims(), tokens(null));
            const [row] = await db().select().from(oauthConnections);
            expect(row?.refreshToken.startsWith("v1:")).toBe(true);
            expect(decryptText(row?.refreshToken ?? "")).toBe("refresh-1");
            await expect(
                saveGoogleConnection(USER, claims("sub-2"), tokens(null)),
            ).rejects.toThrow(/no refresh token/);
        });

        it("revokes the replaced account's grant", async () => {
            const revoke = vi.fn(
                async (_url: unknown, _init?: RequestInit) =>
                    new Response("", { status: 200 }),
            );
            vi.stubGlobal("fetch", revoke);
            await saveGoogleConnection(USER, claims("sub-1"), tokens("old"));
            await saveGoogleConnection(USER, claims("sub-2"), tokens("new"));
            expect(revoke).toHaveBeenCalledTimes(1);
            expect(String(revoke.mock.calls[0]?.[1]?.body)).toBe("token=old");
            expect(await getGoogleConnectionStatus(USER)).toMatchObject({
                subject: "sub-2",
            });
        });

        it("disconnects: revokes, forgets, and reports nothing left", async () => {
            const revoke = vi.fn(async () => new Response("", { status: 200 }));
            vi.stubGlobal("fetch", revoke);
            await saveGoogleConnection(USER, claims(), tokens());
            await expect(disconnectGoogle(USER)).resolves.toBe(true);
            expect(revoke).toHaveBeenCalledTimes(1);
            expect(await getGoogleConnectionStatus(USER)).toBeNull();
            await expect(disconnectGoogle(USER)).resolves.toBe(false);
            await expect(getGoogleAccessToken(USER)).rejects.toMatchObject({
                problem: "not_connected",
            });
        });
    });

    describe("the OAuth callback", () => {
        function sealed(userId = USER, state = "state-1") {
            return sealGoogleOAuthState({
                state,
                verifier: "verifier-1",
                userId,
                returnTo: "/dashboard?folder=f1",
                expiresAt: Date.now() + 60_000,
            });
        }

        function params(values: Record<string, string>) {
            return new URLSearchParams(values);
        }

        function exchange(
            idTokenClaims: Record<string, unknown>,
            scope = DRIVE_SCOPES.join(" "),
        ) {
            return tokenEndpoint({
                access_token: "access-1",
                expires_in: 3600,
                refresh_token: "refresh-1",
                scope,
                id_token: idToken(idTokenClaims),
            });
        }

        const account = {
            sub: "sub-1",
            email: "jane@example.com",
            email_verified: true,
            hd: "example.com",
        };

        it("connects the account and re-plans paused exports", async () => {
            const fetchImpl = exchange(account);
            await expect(
                completeGoogleConnect({
                    userId: USER,
                    sealedState: sealed(),
                    params: params({ state: "state-1", code: "code-1" }),
                    fetchImpl,
                }),
            ).resolves.toEqual({
                outcome: "connected",
                returnTo: "/dashboard?folder=f1",
            });
            const sent = new URLSearchParams(
                String(fetchImpl.mock.calls[0]?.[1]?.body),
            );
            expect(sent.get("code_verifier")).toBe("verifier-1");
            expect(await getGoogleConnectionStatus(USER)).toMatchObject({
                email: "jane@example.com",
                hostedDomain: "example.com",
                status: "active",
            });
            expect(enqueuePlans).toHaveBeenCalledWith(USER);
        });

        it("rejects a state it did not issue, or issued to someone else", async () => {
            const fetchImpl = exchange(account);
            await expect(
                completeGoogleConnect({
                    userId: USER,
                    sealedState: sealed(),
                    params: params({ state: "forged", code: "c" }),
                    fetchImpl,
                }),
            ).resolves.toEqual({
                outcome: "invalid_state",
                returnTo: "/dashboard",
            });
            await expect(
                completeGoogleConnect({
                    userId: USER,
                    sealedState: sealed(OTHER),
                    params: params({ state: "state-1", code: "c" }),
                    fetchImpl,
                }),
            ).resolves.toMatchObject({ outcome: "invalid_state" });
            await expect(
                completeGoogleConnect({
                    userId: USER,
                    sealedState: undefined,
                    params: params({ state: "state-1", code: "c" }),
                    fetchImpl,
                }),
            ).resolves.toMatchObject({ outcome: "invalid_state" });
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(await getGoogleConnectionStatus(USER)).toBeNull();
        });

        it("stores nothing when consent was refused or falls short", async () => {
            const cases: Array<{
                outcome: string;
                claims?: Record<string, unknown>;
                scope?: string;
                error?: string;
                domains?: string[];
            }> = [
                { outcome: "denied", error: "access_denied" },
                {
                    outcome: "domain_not_allowed",
                    claims: { ...account, hd: "other.com" },
                    domains: ["example.com"],
                },
                {
                    outcome: "domain_not_allowed",
                    claims: { ...account, hd: undefined },
                    domains: ["example.com"],
                },
                {
                    outcome: "email_not_verified",
                    claims: { ...account, email_verified: false },
                },
                { outcome: "missing_scope", scope: "openid email" },
            ];
            for (const example of cases) {
                mockEnv.GOOGLE_WORKSPACE_DOMAINS = example.domains ?? [];
                const result = await completeGoogleConnect({
                    userId: USER,
                    sealedState: sealed(),
                    params: params(
                        example.error
                            ? { state: "state-1", error: example.error }
                            : { state: "state-1", code: "c" },
                    ),
                    fetchImpl: exchange(
                        example.claims ?? account,
                        example.scope,
                    ),
                });
                expect(result.outcome).toBe(example.outcome);
            }
            expect(await getGoogleConnectionStatus(USER)).toBeNull();
            expect(enqueuePlans).not.toHaveBeenCalled();
        });

        it("appends the outcome to the return path", () => {
            expect(
                returnUrlWithOutcome(
                    "/dashboard?folder=f1",
                    "connected",
                    "https://riffado.example",
                ).toString(),
            ).toBe(
                "https://riffado.example/dashboard?folder=f1&google=connected",
            );
        });
    });
});
