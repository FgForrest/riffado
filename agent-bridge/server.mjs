#!/usr/bin/env node
/**
 * agent-bridge -- an OpenAI-compatible `chat/completions` endpoint backed
 * by the Claude Code and Codex CLIs.
 *
 * Riffado's summarization surface is generic: both
 * `generateSummaryForRecording` and `generateTitleFromTranscription` do
 * nothing more than `new OpenAI({ baseURL })` +
 * `chat.completions.create`. So anything answering
 * `POST {baseUrl}/chat/completions` is a usable enhancement provider.
 * This process is that, with two coding agents behind it, so a Claude or
 * ChatGPT *subscription* can produce summaries instead of a metered API
 * key.
 *
 * Deliberately zero-dependency. This container holds long-lived OAuth
 * credentials for two paid subscriptions, which makes it the worst place
 * in the stack to add an npm dependency tree -- the CLIs it drives are
 * already its entire trusted surface. Everything here is node: builtins.
 *
 * Never logs prompt or response bodies. The prompt is a user's decrypted
 * transcript, and `generate-summary.ts` goes out of its way to report
 * only a coarse length bucket; this must not undo that. Sizes and
 * durations only.
 *
 * Pure request/response logic lives in `lib.mjs` so it can be tested
 * without a port, a subprocess, or a subscription.
 */

import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    BridgeError,
    buildArgs,
    buildPrompt,
    chatCompletion,
    diagnosticTail,
    parseClaudeEnvelope,
    resolveBackend,
    sanitizeForLog,
    splitArgs,
} from "./lib.mjs";

const PORT = Number(process.env.PORT || 8787);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 300_000);
const MAX_CONCURRENCY = Number(process.env.BRIDGE_MAX_CONCURRENCY || 1);
const MAX_BODY_BYTES = Number(process.env.BRIDGE_MAX_BODY_BYTES || 20_000_000);
const WORKDIR = process.env.BRIDGE_WORKDIR || "/work";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CODEX_BIN = process.env.CODEX_BIN || "codex";

/**
 * Extra CLI flags, space-separated. These are configurable rather than
 * baked in because the useful hardening flags (tool suppression, turn
 * limits) drift between CLI releases, and a flag the installed binary
 * doesn't recognise is a hard startup failure -- which would take the
 * bridge down on a CLI upgrade rather than degrade it. Adopt one after
 * confirming it against your installed version (`claude --help`), with
 * an env change instead of an image rebuild. See README.
 */
const CLAUDE_EXTRA_ARGS = splitArgs(process.env.CLAUDE_EXTRA_ARGS);
const CODEX_EXTRA_ARGS = splitArgs(process.env.CODEX_EXTRA_ARGS);

if (!BRIDGE_TOKEN) {
    console.error(
        "agent-bridge: BRIDGE_TOKEN is required. Without it anything on " +
            "the Docker network could spend your subscription.",
    );
    process.exit(1);
}

// ---------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------

async function runClaude(model, prompt) {
    const { stdout } = await execCli(
        CLAUDE_BIN,
        buildArgs("claude", model, CLAUDE_EXTRA_ARGS),
        prompt,
    );
    return parseClaudeEnvelope(stdout, CLAUDE_BIN);
}

async function runCodex(model, prompt) {
    const dir = await mkdtemp(join(tmpdir(), "agent-bridge-codex-"));
    const outPath = join(dir, "last-message.txt");
    try {
        await execCli(
            CODEX_BIN,
            buildArgs("codex", model, CODEX_EXTRA_ARGS, outPath),
            prompt,
        );

        const text = (await readFile(outPath, "utf8")).trim();
        if (!text) {
            throw new BridgeError(
                502,
                `${CODEX_BIN} finished without producing a final message`,
            );
        }
        return text;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const RUNNERS = { claude: runClaude, codex: runCodex };

/**
 * Run a CLI with the prompt on stdin. See `buildArgs` in lib.mjs for why
 * it must never go in argv.
 */
function execCli(bin, args, stdinText) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
            cwd: WORKDIR,
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
            reject(
                new BridgeError(
                    504,
                    `${bin} exceeded BRIDGE_TIMEOUT_MS (${TIMEOUT_MS}ms)`,
                ),
            );
        }, TIMEOUT_MS);

        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });

        child.on("error", (err) => {
            clearTimeout(timer);
            if (!timedOut) {
                reject(
                    new BridgeError(
                        502,
                        `could not run ${bin}: ${err.message}. Is it installed in this image?`,
                    ),
                );
            }
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) return;
            if (code !== 0) {
                // Codex DOES echo the prompt to stderr -- the original
                // assumption here was wrong, and shipped a 502 body
                // carrying transcript text. diagnosticTail drops any
                // line that came from the prompt.
                const tail = diagnosticTail(stderr, stdinText);
                reject(
                    new BridgeError(
                        502,
                        `${bin} exited with code ${code}${tail ? `: ${tail}` : ""}`,
                    ),
                );
                return;
            }
            resolve({ stdout, stderr });
        });

        // The CLI can exit before draining stdin (bad flag, auth
        // failure), which surfaces here as EPIPE. The non-zero exit above
        // is the real diagnosis; swallow this so it doesn't mask it.
        child.stdin.on("error", () => {});
        child.stdin.end(stdinText);
    });
}

// ---------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------

/**
 * Each request spawns a CLI, which spawns a model session. Running those
 * in parallel burns the subscription's rolling window faster than it
 * accomplishes anything, so the default is a queue of one -- Riffado's
 * auto-summarize path can fire several recordings at once after a sync.
 */
let active = 0;
const waiting = [];

async function withSlot(fn) {
    if (active >= MAX_CONCURRENCY) {
        await new Promise((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
        return await fn();
    } finally {
        active -= 1;
        const next = waiting.shift();
        if (next) next();
    }
}

// ---------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------

function authorized(req) {
    const header = req.headers.authorization || "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(presented);
    const b = Buffer.from(BRIDGE_TOKEN);
    // Length is compared first because timingSafeEqual throws on a length
    // mismatch. Token length is not the secret.
    return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(
                    new BridgeError(
                        413,
                        `request body exceeds BRIDGE_MAX_BODY_BYTES (${MAX_BODY_BYTES})`,
                    ),
                );
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}

/** OpenAI-shaped error, so the `openai` SDK surfaces a usable message. */
function sendError(res, status, message) {
    sendJson(res, status, {
        error: { message, type: "agent_bridge_error", code: status },
    });
}

async function handleChatCompletions(req, res) {
    const raw = await readBody(req);

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        throw new BridgeError(400, "request body is not valid JSON");
    }

    const model =
        typeof payload?.model === "string" ? payload.model.trim() : "";
    if (!model) throw new BridgeError(400, "`model` is required");

    const backend = resolveBackend(model);
    if (!backend) {
        // Echo the rejected id back sanitized: this is the one place an
        // unvalidated model reaches a response body.
        throw new BridgeError(
            400,
            `unknown model "${sanitizeForLog(model, 64)}". This bridge routes ` +
                `ids starting with "claude" to the Claude Code CLI and ` +
                `"codex"/"gpt-5" to the Codex CLI. Set a Default Model on ` +
                `the provider in Riffado.`,
        );
    }

    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
        throw new BridgeError(400, "`messages` must be a non-empty array");
    }

    const prompt = buildPrompt(payload.messages);
    if (!prompt.trim()) {
        throw new BridgeError(400, "`messages` contained no usable content");
    }

    // `temperature` and `max_tokens` arrive from Riffado and are dropped:
    // neither CLI exposes them. Worth stating rather than pretending --
    // replies come out at the agent's own defaults.
    const startedAt = Date.now();
    const content = await withSlot(() => RUNNERS[backend](model, prompt));
    const elapsedMs = Date.now() - startedAt;

    // `model` came off the request body. `resolveBackend` already
    // rejected anything outside MODEL_ID_PATTERN, but the sanitizer stays
    // on the path to the log sink so the guarantee is visible here rather
    // than three calls away -- a newline would otherwise let a caller
    // forge log lines.
    console.log(
        `[agent-bridge] ${backend} model=${sanitizeForLog(model)} ` +
            `prompt_bytes=${Buffer.byteLength(prompt)} ` +
            `reply_bytes=${Buffer.byteLength(content)} ms=${elapsedMs}`,
    );

    sendJson(res, 200, chatCompletion(model, content, randomUUID()));
}

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://localhost");

        // Unauthenticated on purpose: it is the compose healthcheck, and
        // it reveals nothing beyond liveness.
        if (req.method === "GET" && url.pathname === "/health") {
            sendJson(res, 200, { ok: true, active, queued: waiting.length });
            return;
        }

        if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
            throw new BridgeError(
                404,
                `no route for ${req.method} ${url.pathname}`,
            );
        }

        if (!authorized(req)) {
            throw new BridgeError(401, "missing or invalid bearer token");
        }

        await handleChatCompletions(req, res);
    } catch (err) {
        const status = err instanceof BridgeError ? err.status : 500;
        const message =
            err instanceof BridgeError ? err.message : "internal bridge error";
        if (status >= 500) console.error("[agent-bridge]", err);
        if (!res.headersSent) sendError(res, status, message);
        else res.end();
    }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(
        `[agent-bridge] listening on :${PORT} ` +
            `(max_concurrency=${MAX_CONCURRENCY}, ` +
            `timeout_ms=${TIMEOUT_MS}, workdir=${WORKDIR})`,
    );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
        server.close(() => process.exit(0));
    });
}
