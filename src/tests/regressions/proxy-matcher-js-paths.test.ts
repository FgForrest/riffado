import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { ADMIN_HOSTNAME: undefined } }));
vi.mock("@/lib/hosted/hostname-gate", () => ({
    decideHostnameGate: vi.fn(),
}));

import { config } from "@/proxy";

/**
 * regression: the middleware matcher previously excluded all `.js`
 * paths from the extension-exclusion list, so /api/int/script.js and
 * /api/int/replay.js (the Rybbit analytics proxy paths) never reached
 * the middleware at all -- skipping both admin-host isolation
 * (decideHostnameGate) and the auth-header stripping for those routes.
 */
describe("proxy middleware matcher", () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);

    it("still matches .js paths under /api/int/ (must stay gated)", () => {
        expect(pattern.test("/api/int/script.js")).toBe(true);
        expect(pattern.test("/api/int/replay.js")).toBe(true);
    });

    it("still excludes real static assets", () => {
        expect(pattern.test("/favicon.ico")).toBe(false);
        expect(pattern.test("/robots.txt")).toBe(false);
        expect(pattern.test("/sitemap.xml")).toBe(false);
        expect(pattern.test("/some/asset.css")).toBe(false);
        expect(pattern.test("/some/asset.png")).toBe(false);
        expect(pattern.test("/_next/static/chunk.js")).toBe(false);
    });

    it("still matches ordinary app/API routes", () => {
        expect(pattern.test("/admin/billing")).toBe(true);
        expect(pattern.test("/api/int/collect")).toBe(true);
        expect(pattern.test("/dashboard")).toBe(true);
    });

    // Next buffers the whole body of any request the proxy runs on, so the
    // upload route must stay outside it. The route gates admin hosts itself.
    it("skips the upload route, and only that route", () => {
        expect(pattern.test("/api/recordings/upload")).toBe(false);
        expect(pattern.test("/api/recordings/uploads")).toBe(true);
        expect(pattern.test("/api/recordings/upload/x")).toBe(true);
        expect(pattern.test("/api/recordings")).toBe(true);
    });

    // The MCP route caps its body before reading it, after the token check.
    it("skips the MCP route, and only that route", () => {
        expect(pattern.test("/api/mcp")).toBe(false);
        expect(pattern.test("/api/mcp/x")).toBe(true);
        expect(
            pattern.test("/.well-known/oauth-protected-resource/api/mcp"),
        ).toBe(true);
    });

    // A raw mail may be 36 MB: past 10 MB Next cuts a proxied body off.
    it("skips the two mail ingest routes, and only those", () => {
        expect(pattern.test("/api/internal/mail/precheck")).toBe(false);
        expect(pattern.test("/api/internal/mail/ingest")).toBe(false);
        expect(pattern.test("/api/internal/mail/ingest/x")).toBe(true);
        expect(pattern.test("/api/internal/mail")).toBe(true);
    });
});
