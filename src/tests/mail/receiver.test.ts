import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import type { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createReceiver } from "@/lib/mail/receiver/receiver";
import { AllowedSources, spfRanges } from "@/lib/mail/receiver/sources";
import {
    rawMessage,
    signMessage,
    testResolver,
    testSigner,
} from "@/tests/mail/dkim-fixtures";

const company = testSigner("company.example");
const SECRET = "s".repeat(40);

interface AppCall {
    path: string;
    headers: IncomingMessage["headers"];
    body: Buffer;
}

describe("the mail receiver over real SMTP sessions", () => {
    let app: Server;
    let appUrl = "";
    let spool = "";
    const calls: AppCall[] = [];
    let answer: (call: AppCall) => { status: number; body: unknown } = () => ({
        status: 200,
        body: {},
    });
    let receiver: SMTPServer | null = null;
    let port = 0;
    const logs: Record<string, unknown>[] = [];

    beforeAll(async () => {
        spool = mkdtempSync(join(tmpdir(), "riffado-spool-"));
        app = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                const call = {
                    path: request.url ?? "",
                    headers: request.headers,
                    body: Buffer.concat(chunks),
                };
                calls.push(call);
                const { status, body } = answer(call);
                response.writeHead(status, {
                    "content-type": "application/json",
                });
                response.end(JSON.stringify(body));
            });
        });
        await new Promise<void>((resolve) =>
            app.listen(0, "127.0.0.1", resolve),
        );
        appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise((resolve) => app.close(resolve));
        rmSync(spool, { recursive: true, force: true });
    });

    afterEach(async () => {
        calls.length = 0;
        logs.length = 0;
        if (receiver) {
            const closing = receiver;
            receiver = null;
            await new Promise<void>((resolve) =>
                closing.close(() => resolve()),
            );
        }
    });

    async function start(
        options: { sources?: string; maxBytes?: number } = {},
    ) {
        const sources = new AllowedSources(
            options.sources ?? "127.0.0.1/32,::1/128",
        );
        await sources.refresh();
        receiver = createReceiver({
            domain: "klepna.example",
            hostname: "mx.klepna.example",
            ingestUrl: appUrl,
            ingestSecret: SECRET,
            maxMessageBytes: options.maxBytes ?? 1024 * 1024,
            sources,
            spoolDir: spool,
            resolver: testResolver([company]),
            appTimeoutMs: 5_000,
            log: (entry) => logs.push(entry),
        });
        await new Promise<void>((resolve) =>
            receiver?.listen(0, "127.0.0.1", () => resolve()),
        );
        port = (receiver.server.address() as AddressInfo).port;
    }

    function client() {
        return nodemailer.createTransport({
            host: "127.0.0.1",
            port,
            secure: false,
            ignoreTLS: true,
            tls: { rejectUnauthorized: false },
        });
    }

    async function signed(to = "jan@klepna.example") {
        return signMessage(
            rawMessage(
                [
                    "From: jan@company.example",
                    `To: ${to}`,
                    "Subject: Hello",
                    "Date: Fri, 09 Oct 2026 14:02:00 +0200",
                    "Message-ID: <r1@company.example>",
                ],
                "Body text.",
            ),
            company,
        );
    }

    async function send(raw: Buffer, to: string[]) {
        return client().sendMail({
            envelope: { from: "jan@company.example", to },
            raw,
        });
    }

    it("prechecks with metadata, then hands the raw message over, and answers 250", async () => {
        answer = (call) =>
            call.path.endsWith("/precheck")
                ? { status: 200, body: { accepted: ["jan@klepna.example"] } }
                : { status: 200, body: { outcomes: [], overQuota: false } };
        await start();
        const raw = await signed();
        const info = await send(raw, ["jan@klepna.example"]);
        expect(info.accepted).toEqual(["jan@klepna.example"]);
        expect(calls.map((call) => call.path)).toEqual([
            "/api/internal/mail/precheck",
            "/api/internal/mail/ingest",
        ]);
        const precheck = JSON.parse(calls[0]?.body.toString() ?? "{}");
        expect(precheck.recipients).toEqual(["jan@klepna.example"]);
        expect(precheck.facts.dkim[0]).toMatchObject({
            domain: "company.example",
            result: "pass",
        });
        const ingest = calls[1];
        expect(ingest?.headers.authorization).toBe(`Bearer ${SECRET}`);
        expect(ingest?.headers["x-mail-sha256"]).toBe(
            createHash("sha256")
                .update(ingest?.body ?? Buffer.alloc(0))
                .digest("hex"),
        );
        expect(Number(ingest?.headers["content-length"])).toBe(
            ingest?.body.length,
        );
        expect(ingest?.body.toString()).toContain("Body text.");
        expect(JSON.stringify(logs)).not.toContain("jan@");
    });

    it("never sends the message when no recipient would pass, and still answers 250", async () => {
        answer = () => ({ status: 200, body: { accepted: [] } });
        await start();
        const info = await send(await signed(), ["jan@klepna.example"]);
        expect(info.accepted).toEqual(["jan@klepna.example"]);
        expect(calls.map((call) => call.path)).toEqual([
            "/api/internal/mail/precheck",
        ]);
    });

    it("refuses to relay to other domains at RCPT", async () => {
        answer = () => ({ status: 200, body: { accepted: [] } });
        await start();
        await expect(
            send(await signed(), ["someone@elsewhere.example"]),
        ).rejects.toMatchObject({ responseCode: 550 });
        expect(calls).toEqual([]);
    });

    it("answers 451 when the app fails, so the sender retries", async () => {
        answer = (call) =>
            call.path.endsWith("/precheck")
                ? { status: 200, body: { accepted: ["jan@klepna.example"] } }
                : { status: 503, body: {} };
        await start();
        await expect(
            send(await signed(), ["jan@klepna.example"]),
        ).rejects.toMatchObject({ responseCode: 451 });
    });

    it("answers 452 when an owner is over their daily limit", async () => {
        answer = (call) =>
            call.path.endsWith("/precheck")
                ? { status: 200, body: { accepted: ["jan@klepna.example"] } }
                : { status: 200, body: { outcomes: [], overQuota: true } };
        await start();
        await expect(
            send(await signed(), ["jan@klepna.example"]),
        ).rejects.toMatchObject({ responseCode: 452 });
    });

    it("refuses a message over the size limit with 552, without calling the app", async () => {
        answer = () => ({
            status: 200,
            body: { accepted: ["jan@klepna.example"] },
        });
        await start({ maxBytes: 2048 });
        const big = Buffer.from(
            rawMessage(
                [
                    "From: jan@company.example",
                    "To: jan@klepna.example",
                    "Subject: big",
                ],
                "x".repeat(10_000),
            ),
        );
        await expect(send(big, ["jan@klepna.example"])).rejects.toMatchObject({
            responseCode: 552,
        });
        expect(calls).toEqual([]);
    });

    it("refuses connections from anywhere but the allowed sources", async () => {
        await start({ sources: "192.0.2.0/24" });
        await expect(
            send(await signed(), ["jan@klepna.example"]),
        ).rejects.toThrow();
        expect(calls).toEqual([]);
        expect(logs).toContainEqual({
            event: "connect",
            verdict: "source_refused",
        });
    });
});

describe("allowed sources", () => {
    it("follows SPF includes to Google's sending ranges", async () => {
        const records: Record<string, string[][]> = {
            "_spf.google.com": [
                [
                    "v=spf1 include:_netblocks.google.com include:_netblocks2.google.com ~all",
                ],
            ],
            "_netblocks.google.com": [
                ["v=spf1 ip4:209.85.128.0/17 ip4:74.125.0.0/16 ~all"],
            ],
            "_netblocks2.google.com": [["v=spf1 ip6:2001:4860:4000::/36 ~all"]],
        };
        const resolve = async (name: string) => records[name] ?? [];
        expect(await spfRanges("_spf.google.com", resolve)).toEqual([
            "209.85.128.0/17",
            "74.125.0.0/16",
            "2001:4860:4000::/36",
        ]);
        const sources = new AllowedSources("google", resolve);
        expect(sources.allows("209.85.220.41")).toBe(false);
        await sources.refresh();
        expect(sources.allows("209.85.220.41")).toBe(true);
        expect(sources.allows("::ffff:74.125.1.2")).toBe(true);
        expect(sources.allows("2001:4860:4000::1")).toBe(true);
        expect(sources.allows("198.51.100.7")).toBe(false);
    });

    it("keeps the previous ranges when a refresh fails", async () => {
        let fail = false;
        const sources = new AllowedSources("google", async () => {
            if (fail) throw new Error("dns down");
            return [["v=spf1 ip4:192.0.2.0/24 -all"]];
        });
        await sources.refresh();
        fail = true;
        await expect(sources.refresh()).rejects.toThrow("dns down");
        expect(sources.allows("192.0.2.10")).toBe(true);
    });
});
