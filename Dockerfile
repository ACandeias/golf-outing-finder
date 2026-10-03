# syntax=docker/dockerfile:1
#
# Golf Outing Finder images.
#
#   target dev     Node 22 + pnpm toolchain for the dev/test/lint services
#   target builder installs the workspace and runs `pnpm build`
#   target runner  node:22-bookworm-slim with wrangler only; serves the built Worker
#                  with `wrangler dev --local` against a D1 file on /data
#
# `docker compose up --build site` builds and runs the runner (the default target).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_STRICT=0 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    WRANGLER_SEND_METRICS=false
RUN corepack enable
WORKDIR /workspace

# ---------------------------------------------------------------- dev
FROM base AS dev
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/site/package.json ./apps/site/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/pipeline/package.json ./packages/pipeline/
RUN pnpm install --frozen-lockfile
COPY . .
EXPOSE 4321 8787
CMD ["pnpm", "dev"]

# ---------------------------------------------------------------- builder
FROM base AS builder
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/site/package.json ./apps/site/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/pipeline/package.json ./packages/pipeline/
RUN pnpm install --frozen-lockfile
COPY . .
ARG BUILD_VERSION=docker
ENV BUILD_VERSION=${BUILD_VERSION}
# The Cloudflare adapter prerenders static pages through a local preview server
# bound to "localhost". Inside a container, localhost resolves to ::1 first for
# the server and 127.0.0.1 for the client, so the build dies with ECONNREFUSED.
# Resolving IPv4 first on both sides keeps them on the same address.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
RUN pnpm build \
    && node -p "require('./apps/site/node_modules/wrangler/package.json').version" > /tmp/wrangler-version
# The seed as literal-SQL files (cities, ZIPs, courses from the recorded Overpass
# fixture, organizers, outings, sources). Offline: no network calls. The runner's
# entrypoint applies them when the outings table is empty.
RUN node --experimental-strip-types --no-warnings packages/pipeline/src/seed.ts --sql-out /workspace/.seed-sql

# ---------------------------------------------------------------- runner
FROM ${NODE_IMAGE} AS runner
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=development \
    WRANGLER_SEND_METRICS=false \
    PUBLIC_SITE_URL=http://localhost:8787 \
    D1_PERSIST_DIR=/data
WORKDIR /app

# wrangler at the exact version the lockfile resolved, and nothing else.
COPY --from=builder /tmp/wrangler-version /tmp/wrangler-version
RUN npm install -g "wrangler@$(cat /tmp/wrangler-version)" \
    && npm cache clean --force \
    && wrangler --version

# Same relative layout as the repo, so the generated config's paths resolve.
COPY --from=builder /workspace/apps/site/wrangler.toml ./apps/site/wrangler.toml
COPY --from=builder /workspace/apps/site/dist ./apps/site/dist
COPY --from=builder /workspace/apps/site/.wrangler/deploy ./apps/site/.wrangler/deploy
COPY --from=builder /workspace/packages/db/migrations ./packages/db/migrations
# The seed, prebuilt as D1-sized literal SQL files by the builder (pnpm run seed --sql-out).
COPY --from=builder /workspace/.seed-sql ./seed-sql
COPY docker/entrypoint.sh /usr/local/bin/gof-entrypoint

RUN mkdir -p /data && chown -R node:node /data /app/apps/site
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/gof-entrypoint"]
