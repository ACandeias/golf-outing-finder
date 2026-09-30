# Golf Outing Finder

A nationwide directory of golf outings anyone can pay to enter. See `SPEC.md`.

Phase 0 (this commit) is the scaffold: workspace, packages, D1 schema, empty Astro site, CI, deploy and nightly/monthly workflows, plus a Docker dev loop.

## Run it in Docker (recommended, zero host deps except Docker)

```bash
docker compose build
docker compose up worker      # real Cloudflare workerd on http://localhost:8787
docker compose run --rm test  # unit tests
docker compose run --rm lint  # lint + typecheck
docker compose run --rm pipeline   # dry-run pipeline
```

Also useful: `docker compose up dev` (Astro dev server on :4321), `docker compose run --rm shell` (interactive).

## Or run on the host

```bash
pnpm install
pnpm dev
pnpm test
pnpm lint && pnpm typecheck
pnpm run pipeline --dry-run
```

Requires Node 22 and pnpm 12.

## First-time Cloudflare setup (owner)

Only needed to actually deploy to the internet — not for local Docker dev.

1. Create a Cloudflare account (free tier is fine).
2. On the host: `pnpm --filter @gof/site wrangler login` (opens a browser).
3. `pnpm --filter @gof/site wrangler d1 create gof` — copy the `database_id`.
4. Paste it into `apps/site/wrangler.toml` and into the `D1_DATABASE_ID` GitHub Actions secret.
5. Add the other secrets below to your GitHub repo's `production` environment.
6. Push to `main` — `.github/workflows/deploy.yml` migrates D1 and deploys the Worker.

## Secrets

Every secret lives in GitHub Actions' `production` environment (only `main` reads them) or as a Cloudflare Worker secret. No values are committed.

| Name | Where | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Actions | Claude Batch API extraction |
| `SERP_API_KEY` | Actions | SERP provider (DataForSEO or SerpApi) |
| `CLOUDFLARE_API_TOKEN` | Actions | Scoped to D1 edit + Worker deploy |
| `CLOUDFLARE_ACCOUNT_ID` | Actions | Cloudflare account id |
| `D1_DATABASE_ID` | Actions | From `wrangler d1 create` |
| `INDEXNOW_KEY` | Actions + served at `/{key}.txt` | IndexNow ping key |
| `TURNSTILE_SECRET` | Worker secret | `/suggest` form protection |
| `PUBLIC_SITE_URL` | Worker var | Public origin |
| `PUBLIC_ADSENSE_CLIENT` | Worker var | AdSense publisher id (Phase 4) |
| `PUBLIC_GA4_ID` | Worker var | GA4 measurement id |
| `ADS_PROVIDER` | Worker var | `adsense` / `journey` / `raptive` |

Every GitHub Action is pinned to a full commit SHA — see `.github/workflows/*.yml`.

## What the owner still owns

Docker removes the host toolchain requirement, but a few things can only come from you:

- A Cloudflare account (or a scoped `CLOUDFLARE_API_TOKEN`) — no way for code to fabricate one.
- GitHub Actions secrets — added once through the repo Settings UI.
- A domain when Phase 3 arrives (open decision in SPEC section 15).
- Anthropic and SERP provider accounts + spend limits.

Everything else — build, test, lint, migrate, deploy — is fully automated.

## Repo layout

```
apps/site/              Astro app with the Cloudflare adapter
packages/db/            Drizzle schema, migrations, typed queries
packages/pipeline/      nightly and monthly pipeline, CLI
packages/shared/        zod schemas, slug/date/money utils
data/overrides/         YAML the owner edits (SPEC 7.2)
data/places/            metro list (Phase 1)
seed/outings.json       seed dataset and golden cases
seed/guides/            MDX drafts (Phase 3)
tests/fixtures/         saved page text + recorded LLM responses (Phase 2)
.github/workflows/      ci, deploy, nightly, monthly
Dockerfile, docker-compose.yml
```

## What's next

Phase 1 — pages from seed data (SPEC section 13).
