# mail-receiver: Klepna's inbound SMTP server (see mail-receiver/README.md).
# Built from the repository root: `docker compose --profile mail build`.
#
# Node, not Bun, at runtime: Bun's stream adapters buffer what Node's do
# not, and this process takes 36 MB messages from strangers. Bun only
# bundles the TypeScript into one file for Node.

FROM node:22.20.0-bookworm-slim AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/lib/mail ./src/lib/mail
RUN bun build src/lib/mail/receiver/main.ts --target=node --outfile /out/server.mjs

FROM node:22.20.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/server.mjs ./server.mjs
USER node
EXPOSE 2525
CMD ["node", "server.mjs"]
