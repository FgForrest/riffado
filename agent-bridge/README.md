# agent-bridge

An OpenAI-compatible `chat/completions` endpoint backed by the **Claude Code** and **Codex** CLIs, so a Claude or ChatGPT *subscription* can generate Riffado summaries and titles instead of a metered API key.

```
riffado-app ──http──▶ agent-bridge :8787/v1/chat/completions
  (unchanged)           │
                        ├─▶ claude --print      ─▶ Claude subscription
                        └─▶ codex exec          ─▶ ChatGPT subscription
```

Riffado needs no code path of its own for this. Both `generateSummaryForRecording` and `generateTitleFromTranscription` do nothing more than `new OpenAI({ baseURL })` + `chat.completions.create`, so anything answering that URL is a valid enhancement provider.

## Setup

**1. Generate a bridge token** and put it in `.env` at the repo root:

```sh
echo "BRIDGE_TOKEN=$(openssl rand -hex 32)" >> .env
```

**2. Pin the CLI versions** in `.env`. The image defaults to `latest`, which is the wrong posture for a container holding two subscription credentials:

```sh
CLAUDE_CODE_VERSION=x.y.z
CODEX_VERSION=x.y.z
```

**3. Start it.** The service sits behind a compose profile, so it stays out of the way of everyone who doesn't want it:

```sh
docker compose --profile agent-bridge up -d --build agent-bridge
```

**4. Authenticate each CLI**, once. Claude takes either a token or an interactive login; Codex needs the login:

```sh
# Claude -- either a long-lived token in .env ...
claude setup-token          # on your workstation, then paste into .env as CLAUDE_CODE_OAUTH_TOKEN

# ... or an interactive login stored in the agent_creds volume
docker compose run -it --rm agent-bridge claude

# Codex -- interactive only
docker compose run -it --rm agent-bridge codex login
```

**5. Verify before wiring anything up:**

```sh
./agent-bridge/smoke.sh
```

This checks both CLIs run, both are authenticated, `/health` answers, and each backend completes a real round trip returning the JSON shape Riffado parses. It fails with the CLI's own error rather than a 502 three layers up.

**6. Add the provider in Riffado** — Settings → AI Providers → Add, pick **Claude Code** or **Codex**. Base URL and model prefill; paste `BRIDGE_TOKEN` into the API Key field and tick *Use for AI enhancements*.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `BRIDGE_TOKEN` | *(required)* | Bearer token. The bridge refuses to start without it. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | From `claude setup-token`. Optional if you logged in interactively. |
| `BRIDGE_MAX_CONCURRENCY` | `1` | Each request spawns a model session drawing on the same rolling window as your interactive coding. |
| `BRIDGE_TIMEOUT_MS` | `300000` | Per request. The child is SIGKILLed on expiry. |
| `BRIDGE_MAX_BODY_BYTES` | `20000000` | Transcripts are large; this is the ceiling. |
| `CLAUDE_EXTRA_ARGS` / `CODEX_EXTRA_ARGS` | — | Extra flags, space-separated, applied verbatim. |
| `CLAUDE_BIN` / `CODEX_BIN` | `claude` / `codex` | Override to test a different build. |

### Why the extra-args escape hatch

The useful hardening flags — tool suppression, turn limits — drift between CLI releases, and a flag the installed binary doesn't recognise is a **hard startup failure**, not a warning. Baking one in would mean a CLI upgrade could take the bridge down rather than degrade it.

So the baked-in argv is only what's needed to get text in and out, and you add hardening once you've confirmed it against your installed version:

```sh
docker compose exec agent-bridge claude --help
# then, in .env:
CLAUDE_EXTRA_ARGS=--max-turns 1
```

The isolation that *doesn't* depend on flags is structural: the CLIs run as a non-root user with `/work` — an empty directory — as their working directory, so an agent that decides to read or grep finds nothing.

## Model routing

One sidecar serves both CLIs; the `model` field picks the backend.

| Model id | Backend |
|---|---|
| `claude…` (e.g. `claude-sonnet-5`, `claude-haiku-4-5-20251001`) | Claude Code CLI |
| `codex…`, `gpt-5…` | Codex CLI |
| anything else | **400** |

The 400 is deliberate. Riffado falls back to `gpt-4o-mini` when a credential has no Default Model, and silently routing that to Codex would be a confusing way to find out the field was left blank.

Model ids pass through to the CLI unchanged, so the usable set tracks whatever the installed CLI supports rather than a list this bridge has to keep current.

## Things worth knowing

**These are coding agents, not completion endpoints.** Claude Code carries a system prompt tuned for tool use. Riffado's summary prompt demands bare JSON, and an agent sometimes prefaces it with a sentence. The bridge compensates: `extractJson` pulls a JSON payload out of a fenced block or surrounding prose, which Riffado's own fence-stripping (anchored to the very start and end of the string) cannot do. Anything not recognisably JSON passes through untouched, so plain-text callers like title generation are unaffected.

**`temperature` and `max_tokens` are dropped.** Riffado sends them; neither CLI exposes them. Summaries come out at whatever the agent's own defaults are.

**Rate limits are shared with your interactive coding.** A sync that pulls in a dozen recordings with auto-summarize on will draw from the same window as your terminal. `BRIDGE_MAX_CONCURRENCY=1` is the default for that reason. Consider pointing title generation at a cheaper model than summaries.

**Usage numbers are zeros.** The CLIs bill against a subscription and don't report usable per-request counts. The `usage` block keeps the response shape valid; it is not a measurement.

**Terms.** Both subscriptions are licensed for the individual subscriber's use, and neither vendor documents the headless token as a backend integration path. Summarizing your own recordings on your own box is personal use, but there's no SLA on the token flow and either vendor can change it. Keeping one API-key provider configured as a fallback is cheap insurance.

**The credentials volume is sensitive.** `agent_creds` holds `~/.claude` and `~/.codex` — live OAuth tokens for two paid accounts, which the CLIs rotate in place. Treat it like `ENCRYPTION_KEY`. It is why this is a separate container rather than code inside the app image.

**The bridge publishes no port.** It is reachable only from other services on the compose network. Do not add a `ports:` mapping; the bearer token is the only thing between a caller and your subscription.

## Not verified in this repo's CI

CI has no Claude or Codex subscription, so nothing here exercises a real CLI. `src/tests/ai/agent-bridge.test.ts` covers the pure request/response logic — auth, model routing, message flattening, JSON extraction — by importing the module's helpers. The CLI invocation itself is what `smoke.sh` is for; run it after any CLI upgrade.
