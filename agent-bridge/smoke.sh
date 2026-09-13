#!/usr/bin/env bash
# End-to-end check for the agent-bridge sidecar.
#
# Run this BEFORE pointing Riffado at the bridge. It fails on the things
# that actually go wrong first -- a CLI that isn't installed, a
# subscription that isn't logged in, a flag the installed version doesn't
# know -- and it fails with the CLI's own error rather than a 502 three
# layers up.
#
#   ./agent-bridge/smoke.sh
#   ./agent-bridge/smoke.sh claude      # one backend only
#
# Reads BRIDGE_TOKEN from the environment or from ./.env.
set -uo pipefail

SERVICE=agent-bridge
ONLY="${1:-}"
FAILED=0

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()   { printf '   \033[32mok\033[0m  %s\n' "$1"; }
bad()  { printf '   \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }

if [ -z "${BRIDGE_TOKEN:-}" ] && [ -f .env ]; then
    BRIDGE_TOKEN="$(grep -E '^BRIDGE_TOKEN=' .env | head -1 | cut -d= -f2-)"
fi
if [ -z "${BRIDGE_TOKEN:-}" ]; then
    echo "BRIDGE_TOKEN is not set and not found in ./.env" >&2
    exit 1
fi

step "container"
if docker compose ps --status running --services 2>/dev/null | grep -qx "$SERVICE"; then
    ok "$SERVICE is running"
else
    bad "$SERVICE is not running -- 'docker compose up -d $SERVICE' first"
    exit 1
fi

step "CLIs installed"
for bin in claude codex; do
    if v=$(docker compose exec -T "$SERVICE" "$bin" --version 2>&1); then
        ok "$bin $(echo "$v" | head -1)"
    else
        bad "$bin not runnable: $(echo "$v" | head -1)"
    fi
done

step "subscription auth"
# Ask each CLI rather than stat-ing its credential file. The file layout
# is an implementation detail, and for Codex a present auth.json proves
# nothing useful: `codex login --with-api-key` writes one too, and that
# bills per token -- the exact thing this bridge exists to avoid.
if claude_status=$(docker compose exec -T "$SERVICE" claude auth status 2>&1); then
    ok "claude: $(echo "$claude_status" | tail -1)"
elif [ -n "$(docker compose exec -T "$SERVICE" printenv CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null)" ]; then
    ok "claude using CLAUDE_CODE_OAUTH_TOKEN"
elif docker compose exec -T "$SERVICE" test -s /home/node/.claude/.credentials.json 2>/dev/null; then
    # Fallback for CLI versions predating `claude auth status`.
    ok "claude credential file present"
else
    bad "no claude credential -- see 'Authentication' in agent-bridge/README.md"
fi

# `codex login status` exits 0 for API-key auth too, so read the mode.
if codex_status=$(docker compose exec -T "$SERVICE" codex login status 2>&1); then
    case "$codex_status" in
        *ChatGPT*)
            ok "codex: $(echo "$codex_status" | tail -1)" ;;
        *)
            bad "codex is logged in, but NOT with a ChatGPT subscription: $(echo "$codex_status" | tail -1)" ;;
    esac
else
    bad "codex not logged in -- 'docker compose run --rm $SERVICE codex login --device-auth'"
fi

step "health"
if docker compose exec -T "$SERVICE" node -e \
    "fetch('http://127.0.0.1:8787/health').then(r=>r.json()).then(j=>{console.log(JSON.stringify(j));process.exit(j.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})"; then
    ok "/health responded"
else
    bad "/health did not respond"
fi

# One real round trip per backend. Asks for the exact JSON shape
# `generate-summary.ts` parses, so a pass here means the real thing works.
probe() {
    local label="$1" model="$2"
    step "round trip: $label ($model)"
    docker compose exec -T -e BRIDGE_TOKEN="$BRIDGE_TOKEN" -e PROBE_MODEL="$model" "$SERVICE" node -e '
      const body = {
        model: process.env.PROBE_MODEL,
        messages: [
          { role: "system", content: "You summarize transcripts. Respond with valid JSON only, no markdown fences." },
          { role: "user", content: "Transcript: \"We agreed to ship on Friday. Ana will write the release notes.\"\nReturn {\"summary\":string,\"keyPoints\":string[],\"actionItems\":string[]}." },
        ],
        temperature: 0.5,
        max_tokens: 2000,
      };
      const started = Date.now();
      fetch("http://127.0.0.1:8787/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.BRIDGE_TOKEN },
        body: JSON.stringify(body),
      })
        .then(async (r) => {
          const text = await r.text();
          if (!r.ok) { console.error(text.slice(0, 800)); process.exit(1); }
          const content = JSON.parse(text).choices?.[0]?.message?.content ?? "";
          console.log("   reply in " + ((Date.now() - started) / 1000).toFixed(1) + "s, " + content.length + " chars");
          try {
            const parsed = JSON.parse(content);
            console.log("   parsed JSON, keys: " + Object.keys(parsed).join(", "));
          } catch {
            console.log("   NOT valid JSON -- Riffado would store the whole reply as the summary:");
            console.log("   " + content.slice(0, 200).replace(/\n/g, " "));
          }
        })
        .catch((e) => { console.error(e.message); process.exit(1); });
    ' && ok "$label answered" || bad "$label failed"
}

[ "$ONLY" = "codex" ]  || probe "Claude Code" "${CLAUDE_PROBE_MODEL:-claude-sonnet-5}"
[ "$ONLY" = "claude" ] || probe "Codex" "${CODEX_PROBE_MODEL:-gpt-5-codex}"

printf '\n'
if [ "$FAILED" -eq 0 ]; then
    printf '\033[32mall checks passed\033[0m -- safe to point Riffado at http://agent-bridge:8787/v1\n'
else
    printf '\033[31msome checks failed\033[0m -- see above\n'
    exit 1
fi
