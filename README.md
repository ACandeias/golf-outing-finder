# Golf Outing Finder

A nationwide directory of golf outings that anyone can pay to enter, at municipal, public, semi-private, private and resort courses. It's free to use, earns money only from display ads, and runs unattended. The build spec is [`SPEC.md`](SPEC.md) (v1.1) and the working rules for contributors and agents are in [`CLAUDE.md`](CLAUDE.md).

Status: **Phase 2** in progress. Workstream A (pipeline skeleton) is done: stage contracts, overrides loader, budget guard, runs accounting, CLI, D1 edge and the golden-test harness; see [`packages/pipeline/README.md`](packages/pipeline/README.md). Phase 1 delivered every site route from seed data; Phase 0 the scaffold, schema, CI, Docker and seed fixtures.

## Run locally in Docker

This is the first way to run the project, and the first deployment target. You need Docker only, with no Node, pnpm or wrangler on the host.

```bash
cp .env.example .env        # optional; no secrets in it
pnpm docker:up              # or: docker compose up --build site
```

Then open http://localhost:8787 and http://localhost:8787/health (`{"ok":true,"version":"docker"}`).

What happens:

1. The `builder` stage installs the workspace with `pnpm install --frozen-lockfile` and runs `pnpm build`.
2. The `runner` stage is `node:22-bookworm-slim` with only wrangler (at the lockfile's version), the built Worker, the migrations and the seed file. It runs as the `node` user under `tini`.
3. The `builder` stage also runs the seed loader offline with `--sql-out`, producing the seed as D1-sized literal-SQL files (`/app/seed-sql` in the runner).
4. On start, `docker/entrypoint.sh` applies D1 migrations with `wrangler d1 migrations apply gof --local --persist-to /data`. If the `outings` table is empty, it applies the seed SQL files with `wrangler d1 execute gof --local --file`. Then it runs `wrangler dev --local --ip 0.0.0.0 --port 8787 --persist-to /data`.
5. The local D1 database lives on the named volume `d1-data` mounted at `/data`, so it survives restarts. Run `docker compose down -v` to reset it.

`.env` settings: `PUBLIC_SITE_URL` (default `http://localhost:8787`), `SITE_NOW` (pins the clock, ignored when `NODE_ENV=production`), and `NODE_ENV` (default `development`).

Dev toolchain containers, which bind-mount the repo, sit behind the `dev` profile:

```bash
docker compose --profile dev up dev          # Astro dev server on :4321
docker compose --profile dev run --rm test   # unit + golden tests
docker compose --profile dev run --rm lint   # lint + typecheck
docker compose --profile dev run --rm shell  # shell with Node 22 and pnpm
```

## Run on the host

Requires Node 22 LTS (`.nvmrc`) and pnpm 12 (`packageManager` in `package.json`; `corepack enable` picks it up).

pnpm 12 reserves some subcommand names, including `pipeline`, so scripts run as `pnpm run <script>`. The short forms below work for the others.

```bash
pnpm install
pnpm dev                      # Astro + wrangler dev with a local D1
pnpm test                     # unit + golden tests, offline
pnpm test:e2e                 # Playwright against wrangler dev with seeded D1
pnpm lint && pnpm typecheck
pnpm db:migrate:local         # apply migrations to local D1
pnpm db:migrate:remote        # apply migrations to production D1 (CI only)
pnpm run seed                 # load places, courses and seed/outings.json into local D1 (see below)
pnpm run pipeline --dry-run   # full pipeline on fixtures, zero network calls
pnpm run pipeline --live --budget=nightly   # real run; used by nightly.yml
pnpm test:live-extract        # re-record LLM fixtures (costs money, asks first)
pnpm build && pnpm deploy     # deploy the Worker (CI only)
pnpm docker:up                # build and run the site in Docker
```

## Seed data and loaders (Phase 1)

```bash
pnpm db:migrate:local
pnpm run seed                          # full reload of the local D1, offline
pnpm run seed --include-test-entries   # also load s14 (excluded, unpublished) and s15 (synthetic gc7)
pnpm run seed --sql-out=.cache/seed    # only write the SQL files (the Docker builder does this)
pnpm run seed:course-types             # one-time: seed expected_course_type -> course-types.yaml (already committed)
pnpm run courses:import --states=NY,NJ # courses from tests/fixtures/courses.json into the local D1 (upsert by osm_ref)
pnpm run courses:import --states=NY --live   # same from the free Overpass API, one state at a time with backoff
pnpm run places:build [--all]          # re-download GeoNames and rebuild data/places (free, CC BY 4.0)
pnpm run places:load                   # cities and zips only
```

`pnpm run seed` clears and reloads `cities`, `zips`, `courses`, `organizers`, `outings`, `sources` and `source_outings` in the local D1:

- **Places**: `data/places/cities.csv.gz` and `zips.csv.gz` (GeoNames subsets for the ten seed states).
- **Courses**: `tests/fixtures/courses.json` (recorded once from Overpass by `packages/pipeline/scripts/record-courses-fixture.ts`) through the importer: SPEC 8.1 steps 1 (`course-types.yaml`), 2 (OSM tags) and 4 (`unknown`); mini golf and driving ranges dropped; `time_zone` from tz-lookup; `city` from `addr:city`, else the nearest city within 30 km.
- **Outings**: every seed entry is matched to a course with the SPEC 8.6 matcher; the run fails listing any entry that doesn't match. Prices become cents, open entries are `open`, expected entries keep the seed's `expected_month` (and `announced_date` as `start_date`), e17 is held with `hold_reason = 'no_date'`. Organizers are `unverified` with `org_type` from the outing type. `source_url`, `event_url` and `registration_url` become `sources` rows linked through `source_outings`. `registration_url` is kept only when it is on the page's domain or a host in `registration-hosts.yaml`. `removals.yaml` is honored. `synthetic` and `excluded` entries are skipped unless `--include-test-entries`.
- **Writes**: literal-value SQL (no bound parameters), at most 50 rows per statement, at most 1,000 statements per file, applied with `wrangler d1 execute gof --local --file`. Tests apply the same SQL to node:sqlite. `PIPELINE_NOW` pins the clock outside production.

To serve the built Worker the way CI and Docker do:

```bash
pnpm db:migrate:local && pnpm build
pnpm --filter @gof/site exec wrangler dev --local --port 8787 --var NODE_ENV:development
curl http://localhost:8787/health
```

Never call a paid API (DataForSEO, Claude) outside `pnpm run pipeline --live` or `pnpm test:live-extract`. Every other command uses fixtures.

## Layout

```
apps/site/                Astro 7 + @astrojs/cloudflare 14, output: 'server'
  src/pages/              /, /health, /robots.txt, /ads.txt (routes grow in Phase 1)
  src/lib/env.ts          Worker vars from cloudflare:workers, validated with zod
  wrangler.toml           Worker config, D1 binding DB -> database "gof"
  tests/e2e/              Playwright against wrangler dev
packages/db/              Drizzle schema (src/schema.ts) mirroring SPEC 7.1
  src/queries.ts          typed read queries for the site (listings, lookups, sitemaps)
  src/testing.ts          node:sqlite + drizzle sqlite-proxy helpers for tests
  migrations/0000_init.sql  the D1 schema; tests/ apply it to SQLite and check it
packages/shared/          zod env schemas, budget profiles, slug/date/money utils, extraction schema,
                          places helpers and attributions, display-label table, ULIDs
packages/pipeline/        nightly and monthly pipeline CLI (Phase 2), loaders (Phase 1); see its README
  src/stages/             pure stage contracts (types.ts), row schemas, stubs, report stage
  src/run/                runner, runs-row accounting, stage handlers, step summary
  src/d1/                 D1 edge: wrangler export/execute and an in-memory port
  src/budget.ts           budget guard: per-run caps, monthly spend cap, cost estimates
  src/overrides/          zod readers for data/overrides and metros.yaml
  tests/golden/           golden-case harness and gc1..gc8 tests
  src/match/              course matcher (SPEC 8.6)
  src/courses/            Overpass client, OSM course-type rules, course importer
  src/places/             GeoNames parsing, places:build, city locator
  src/seed/ src/seed.ts   seed loader and seed:course-types
  src/sql/                literal SQL for D1
  scripts/record-seed-fixtures.ts     one-time Phase 0 page recorder (free HTTP only)
  scripts/record-courses-fixture.ts   one-time Overpass recorder for tests/fixtures/courses.json
data/overrides/           YAML the owner edits (SPEC 7.2)
data/places/              GeoNames subsets for the seed states and metros.yaml
seed/outings.json         32 seed entries and the golden cases (SPEC 11)
seed/guides/              guide drafts (Phase 3)
tests/fixtures/           raw/ HTML and pages/ normalized records of the seed pages (plus hand-written
                          *.synthetic.json for gc1 and gc5); MISSING.md; llm/ recorded extractions;
                          courses.json (recorded Overpass subset, © OpenStreetMap contributors);
                          irs-subset.csv (synthetic IRS BMF rows)
docker/entrypoint.sh      runner entrypoint: migrate, seed, serve
Dockerfile                dev, builder and runner stages
docker-compose.yml        site service (default) and dev profile services
.github/workflows/        ci, deploy, nightly, monthly; dependabot.yml
```

## Secrets and variables

No values are committed anywhere. GitHub Actions secrets live in the `production` environment, which only `main` can use.

| Name | Where | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Actions secret | Claude Message Batches extraction and course-type classification. Set a monthly spend limit in the Claude Console |
| `SERP_API_KEY` | Actions secret | DataForSEO credentials as `login:password` |
| `CLOUDFLARE_API_TOKEN` | Actions secret | Scoped to D1 edit on this database and deploy on this Worker. While it is empty, `deploy.yml` prints a notice and skips the deploy |
| `CLOUDFLARE_ACCOUNT_ID` | Actions secret | Cloudflare account id |
| `D1_DATABASE_ID` | Actions secret | From `wrangler d1 create gof`; also goes in `apps/site/wrangler.toml` |
| `INDEXNOW_KEY` | Actions secret and Worker var | IndexNow pings; the site serves `/{key}.txt` |
| `TURNSTILE_SECRET` | Worker secret (`wrangler secret put`) | `/suggest` form protection |
| `PUBLIC_SITE_URL` | Worker var, and Actions variable (`vars.PUBLIC_SITE_URL`) for the nightly env | Public origin; also in the crawler user agent |
| `PUBLIC_ADSENSE_CLIENT` | Worker var | AdSense publisher id (Phase 4) |
| `PUBLIC_GA4_ID` | Worker var | GA4 measurement id |
| `ADS_PROVIDER` | Worker var | `adsense`, `journey` or `raptive` |
| `PIPELINE_NOW`, `SITE_NOW` | Local and test env only | Pin the clock; ignored when `NODE_ENV=production` |
| Budget caps and `MONTHLY_SPEND_CAP_CENTS` | Env, defaults in `packages/shared/src/budget.ts` | SPEC section 14; raising one needs the owner's approval |

`packages/shared/src/env.ts` validates all of these with zod at startup.

## Owner tasks

These are blocking steps only the owner can do (plan Part 3):

| When | Task |
| --- | --- |
| Before the first Cloudflare deploy | Run `npx wrangler login` on this machine, or export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Subscribe to Workers Paid ($5/month). Run `pnpm --filter @gof/site exec wrangler d1 create gof`, put the `database_id` in `apps/site/wrangler.toml`, and add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `D1_DATABASE_ID` to the GitHub `production` environment. The next push to `main` migrates and deploys; check that the workers.dev URL returns 200 on `/` and `/health`. |
| Before the Phase 1 remote seed | Nothing extra. Once logged in, the agent runs `pnpm db:migrate:remote` and the remote seed. |
| Before Phase 2 fixture recording | Create an Anthropic API key with a monthly spend limit and export `ANTHROPIC_API_KEY`. Approve the one-time `pnpm test:live-extract` (about $0.50). |
| Before the first live nightly | Open a DataForSEO account (minimum deposit applies). Add `SERP_API_KEY`, `ANTHROPIC_API_KEY`, `CLOUDFLARE_*`, `D1_DATABASE_ID` and `INDEXNOW_KEY` to the GitHub `production` environment, and set the `PUBLIC_SITE_URL` Actions variable. |
| Phase 3 | Choose the domain and attach it to the Worker so edge caching works. Verify Search Console and Bing. |
| Ongoing | Merge Dependabot PRs. A public repo's scheduled workflows are disabled after 60 days without a commit; re-enable them from the Actions tab if that happens. |

Also see `tests/fixtures/MISSING.md` for seed pages that couldn't be recorded (s14 returns 404; Scramble Hunter hides details behind a login).

## Security

Every GitHub Action is pinned to a full 40-character commit SHA, and workflows default to `permissions: contents: read`. Scraped text is rendered as text only. The crawler identifies itself as `GolfOutingFinderBot/1.0 (+{SITE_URL}/bot)` and honors robots.txt. See SPEC section 10.
