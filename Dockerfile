# Golf Outing Finder dev toolchain.
# One image that owns Node 22, pnpm and wrangler, so contributors and CI
# don't need to install any of those on the host.
#
# Build:  docker compose build
# Dev:    docker compose up dev         # Astro at http://localhost:4321
# Worker: docker compose up worker      # Real workerd at http://localhost:8787
# Test:   docker compose run --rm test
# Lint:   docker compose run --rm lint

FROM node:22-bookworm-slim

# Wrangler and the Cloudflare adapter need a handful of native deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/*

# Enable Corepack so pnpm@<packageManager> resolves without a global install.
ENV COREPACK_ENABLE_STRICT=0
RUN corepack enable

WORKDIR /workspace

# Prime the pnpm store in a separate cached layer.
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./
COPY apps/site/package.json ./apps/site/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/pipeline/package.json ./packages/pipeline/
RUN pnpm install --prefer-frozen-lockfile || pnpm install

# Then the source. Bind mounts in compose overlay this at runtime.
COPY . .

EXPOSE 4321 8787

CMD ["pnpm", "dev"]
