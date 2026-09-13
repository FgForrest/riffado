# agent-bridge: OpenAI-compatible `chat/completions` in front of the
# Claude Code and Codex CLIs.
#
# Same Node pin as the app's `deps` stage (see the root Dockerfile) so
# there is one Node version to track across the stack.
FROM node:22.20.0-bookworm-slim

# PIN THESE BEFORE DEPLOYING. `latest` is the wrong default for a
# container that holds OAuth credentials for two paid subscriptions -- it
# is the "first adopter" position the Dependabot `cooldown` block in
# `.github/dependabot.yml` and pnpm's `minimumReleaseAge` both exist to
# avoid. They default to `latest` only because a pinned version would be
# stale the week this lands; set them in `.env` and rebuild.
#
#   docker compose build --build-arg CLAUDE_CODE_VERSION=x.y.z agent-bridge
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

# git: both CLIs shell out to it for repo context and warn loudly without
# it. ca-certificates: TLS to the vendor APIs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install scripts run here by necessity -- the Codex package places a
# platform binary in its postinstall. That is the trade this image makes
# explicit: the two CLIs are its entire trusted surface, which is also
# why `server.mjs` has no npm dependencies of its own.
RUN npm install -g \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

# The CLIs are agents: they will look at whatever directory they are
# started in. Give them an empty one that is not the app source, so a
# stray Read/Grep finds nothing rather than the repo. Credentials live in
# /home/node, which is the volume mount point -- the CLIs refresh their
# own OAuth tokens in place, so it has to be writable and persistent.
RUN mkdir -p /work /home/node/.claude /home/node/.codex /srv/agent-bridge \
    && chown -R node:node /work /home/node /srv/agent-bridge

COPY --chown=node:node server.mjs /srv/agent-bridge/server.mjs

USER node
ENV HOME=/home/node \
    CODEX_HOME=/home/node/.codex \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    NODE_ENV=production \
    BRIDGE_WORKDIR=/work \
    PORT=8787

WORKDIR /work
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/srv/agent-bridge/server.mjs"]
