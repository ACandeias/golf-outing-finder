# Golf Outing Finder

A nationwide directory of golf outings that anyone can pay to enter, at municipal, public, semi-private, private and resort courses. It's free to use, earns money only from display ads, and runs unattended. The build spec is [`SPEC.md`](SPEC.md) (v1.1) and the working rules for contributors and agents are in [`CLAUDE.md`](CLAUDE.md).

Status: **Phase 2** (pipeline) is wired end to end: every nightly stage runs on fixtures with zero network calls in CI (`pnpm run pipeline --dry-run --strict`), and the live path is ready but has not run yet (owner steps below). See [`packages/pipeline/README.md`](packages/pipeline/README.md). Phase 1 delivered every site route from seed data; Phase 0 the scaffold, schema, CI, Docker and seed fixtures.

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

**Serving the host's database.** `pnpm run docker:up:local` (`docker compose -f docker-compose.yml -f docker-compose.local.yml up --build site`) replaces the `d1-data` volume with a bind mount of `./apps/site/.wrangler/state` at `/data`, so the container serves whatever the host writes there: `pnpm run seed`, `pnpm run courses:import --live`, or a pipeline run with `--d1=local --persist-to apps/site/.wrangler/state`. wrangler keeps the database under `<dir>/v3/d1` in both places. The entrypoint still applies pending migrations, and seeds only when `outings` is empty, so a database the pipeline filled is served as it is. Avoid writing from the host while the container serves a page that writes; both share one SQLite file.

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
pnpm run pipeline --live --budget=smoke     # first live run: every cap at 5 to 10
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

## Pipeline (Phase 2)

**How the nightly runs.** `nightly.yml` starts at 07:15 UTC in the `production` environment, restores `.cache/irs` (the IRS lookup database, keyed `irs-YYYY-MM`) and `.cache/http-validators.json` (ETag and Last-Modified per URL) from the Actions cache, and runs `pnpm run pipeline --live --budget=nightly --strict`. The run exports the remote D1 to a local SQLite snapshot, writes its `runs` row, then runs discover, fetch, normalize, extract (Message Batches: submit, poll every 60 seconds for up to 45 minutes, a batch still running is collected by the next night), classify, match, dedupe-upsert, publish (with IndexNow pings) and recheck/roll-forward, writing to D1 after every stage with `wrangler d1 execute --remote --file`. The report goes to the job summary: stage statuses, counts, holds by reason across `sources` and `outings`, budget hits, errors and the estimated cost. The job fails, and GitHub emails the owner, when a stage throws or more than 20% of fetches fail with a network error or a 5xx. `monthly.yml` runs courses, IRS and course types on the 1st. Both share the `pipeline` concurrency group.

**Dry run and smoke run.**

```bash
PIPELINE_NOW=2026-09-28 pnpm run pipeline --dry-run --strict                              # what CI runs
PIPELINE_NOW=2026-09-28 MAX_SERP_QUERIES_PER_RUN=5 pnpm run pipeline --dry-run --strict   # search stops at 5, the rest completes
PIPELINE_NOW=2026-09-28 pnpm run pipeline --dry-run --fail-stage=fetch                    # exits 1, runs row keeps the error
pnpm run pipeline --live --budget=smoke                                                   # first live run (secrets required)
```

**On the Claude subscription, locally.** With Claude Code logged in on this machine (`claude -p` works), a live run needs no API key and no DataForSEO account:

```bash
pnpm run pipeline --live --budget=smoke --llm=claude-cli --serp=claude-search \
  --d1=local --persist-to apps/site/.wrangler/state
pnpm run pipeline --live --budget=nightly --llm=claude-cli --serp=claude-search \
  --d1=local --persist-to apps/site/.wrangler/state --prioritize-states=NY,NJ,CT
pnpm run docker:up:local     # serve the result on http://localhost:8787
```

`--llm=claude-cli` runs each extraction as `claude -p` on claude-haiku-4-5 with the same prompt and JSON schema as the Batches path; `--serp=claude-search` answers each search query with `claude -p` and only its WebSearch tool. The caps apply as usual; the report gives the cost at API rates and says the subscription covered it. Load the courses first (`pnpm run courses:import --live --persist-to apps/site/.wrangler/state`), or most outings are held as `course_unmatched`. See `packages/pipeline/README.md`, "Subscription-backed providers".

The dry run uses an in-memory D1 loaded with the fixture places and courses, the recorded seed pages in `tests/fixtures/raw` (and the hand-written stand-ins in `tests/fixtures/pages/*.synthetic.json`), the LLM results in `tests/fixtures/llm`, the SERP and listing fixtures, and the IRS subset. On the pinned date it creates and publishes 9 outings from 14 pages, excludes gc1 and holds 3 calendar entries whose course isn't in the fixtures. The smoke profile caps every count at 5 to 10 (5 searches, 10 fetches, 10 extractions); in Actions, run the nightly workflow by hand and choose `smoke`.

**Fixture layout.** `tests/fixtures/pages/{id}.json` (normalized seed pages) and `raw/{id}.html` (the HTML the dry run serves), `pages/{id}.synthetic.json` (hand-written stand-ins for gc1 and gc5), `llm/{id}.json` (Message Batches results for gc1 to gc8; hand-written with `recorded: false` until `pnpm test:live-extract` re-records them), `discovery/` and `serp/` (listing pages, sitemaps and DataForSEO responses), `course-types/` (monthly dry run), `courses.json` (recorded Overpass subset), `irs-subset.csv` (synthetic IRS rows). `MISSING.md` lists what couldn't be recorded.

### Before the first live run (owner)

1. **Cloudflare D1.** `pnpm --filter @gof/site exec wrangler d1 create gof`, then put the id in `apps/site/wrangler.toml` (`database_id`, replacing `REPLACE_WITH_D1_DATABASE_ID`) and commit it. A live run refuses to start while the placeholder is there, or when it differs from `D1_DATABASE_ID`. Run `pnpm db:migrate:remote` (or let `deploy.yml` do it) and load the courses once (the monthly workflow, run by hand).
2. **Secrets** in the GitHub `production` environment: `ANTHROPIC_API_KEY` (with a monthly spend limit set in the Claude Console), `SERP_API_KEY` (DataForSEO `login:password`), `CLOUDFLARE_API_TOKEN` (D1 edit on this database and Worker deploy only), `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, and optionally `INDEXNOW_KEY`. Set the `PUBLIC_SITE_URL` Actions variable; the crawler's user agent uses it. A live run checks all of these with the shared zod schema and refuses to start, naming what's missing, without them.
3. **DataForSEO.** Open the account and make the minimum deposit, then add its credentials as `SERP_API_KEY`. A live nightly or smoke run refuses to start without it.
4. **Listing sources.** In `data/overrides/platforms.yaml` every platform and directory has `allowed: false`. Read each site's terms of use, then set `allowed: true` and `terms_checked: <date>` for the ones that permit reading public listings. Nothing with `allowed: false` is fetched; robots.txt is honored either way.
5. **First run.** Run the nightly workflow by hand with `smoke`. Check the job summary and the `runs` row (`est_cost_cents`), then let the schedule take over.

## Layout

```
apps/site/                Astro 7 + @astrojs/cloudflare 14, output: 'server'
  src/pages/              /, /health, /robots.txt, /ads.txt, /{INDEXNOW_KEY}.txt, /guides, the listing routes
  src/content.config.ts   the guides collection (seed/guides/*.md); drafts only in non-production builds
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
seed/guides/              guides as plain Markdown (Phase 3, SPEC 9.8); apps/site/src/content.config.ts loads them
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
| `INDEXNOW_KEY` | Actions secret and Worker var (the same value in both) | IndexNow pings; the site serves `/{key}.txt` as text and 404s any other `.txt` path. 8 to 128 letters, digits or dashes |
| `TURNSTILE_SECRET` | Worker secret (`wrangler secret put`) | `/suggest` form protection |
| `PUBLIC_SITE_URL` | Worker var, and Actions variable (`vars.PUBLIC_SITE_URL`) for the nightly env | Public origin; also in the crawler user agent |
| `PUBLIC_ADSENSE_CLIENT` | Worker var | AdSense publisher id (Phase 4) |
| `PUBLIC_GA4_ID` | Worker var | GA4 measurement id |
| `ADS_PROVIDER` | Worker var | `adsense`, `journey` or `raptive` |
| `GOOGLE_SITE_VERIFICATION` | Worker var, optional | Search Console HTML-tag token (the `content` value only). The home page renders `<meta name="google-site-verification">` only when it is set |
| `BING_SITE_VERIFICATION` | Worker var, optional | Bing Webmaster Tools token (the `content` value only), rendered as `<meta name="msvalidate.01">` on the home page only when set |
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
| Before the first live nightly | See [Before the first live run](#before-the-first-live-run-owner): the D1 id in `wrangler.toml`, the secrets and `PUBLIC_SITE_URL`, DataForSEO, the `allowed` flags in `platforms.yaml`, then one `smoke` run. |
| Phase 3 | Choose the domain and attach it to the Worker so edge caching works. Verify the site in Search Console and Bing Webmaster Tools: either add a DNS TXT record for the domain (no deploy needed, and it covers every subdomain), or copy each HTML-tag token into the `GOOGLE_SITE_VERIFICATION` and `BING_SITE_VERIFICATION` Worker vars (`wrangler.toml` `[vars]` or the dashboard) and redeploy. Then submit `/sitemap-index.xml` to both. Set the same `INDEXNOW_KEY` as a Worker var and an Actions secret. |
| Phase 3 guides | Review the drafts in `seed/guides/` and publish each by setting `draft: false` (and `updated` to the review date). Drafts are built only when the build's `NODE_ENV` isn't `production` (`pnpm dev`, the e2e build), always carry `noindex`, and never appear in sitemaps; `pnpm build` and the deploy leave them out of `dist/` entirely. |
| Ongoing | Merge Dependabot PRs. A public repo's scheduled workflows are disabled after 60 days without a commit; re-enable them from the Actions tab if that happens. |

Also see `tests/fixtures/MISSING.md` for seed pages that couldn't be recorded (s14 returns 404; Scramble Hunter hides details behind a login).

## Security

Every GitHub Action is pinned to a full 40-character commit SHA, and workflows default to `permissions: contents: read`. Scraped text is rendered as text only. The crawler identifies itself as `GolfOutingFinderBot/1.0 (+{SITE_URL}/bot)` and honors robots.txt. See SPEC section 10.
