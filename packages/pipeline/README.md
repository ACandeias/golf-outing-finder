# @gof/pipeline

The nightly and monthly pipeline (SPEC.md section 8) and the Phase 1 loaders. This page covers how a
run is put together (stage contracts and the wiring between them), the dry run on fixtures, the
caps, the live runs, the fixture layout and the CLI.

## Shape of a run

```
cli.ts ─ parse args; live: preflight (secrets, D1 id) or refuse; dry run: block the network
  │       build Context once, open the D1 port (dry run: in-memory, fixture places and courses loaded)
  │       build the run's edges once (run/wire.ts: fetch side, batch client, IRS, IndexNow)
  └─ run/runner.ts
       ├─ write the runs row (start)
       ├─ D1 snapshot (wrangler d1 export → SQLite file, read with node:sqlite)
       ├─ BudgetGuard (caps + this month's runs for MONTHLY_SPEND_CAP_CENTS)
       ├─ for each stage: handler → edges (ports) + pure stage → UpsertPlan → d1.apply → update runs row
       └─ report stage → stdout and $GITHUB_STEP_SUMMARY → exit code
  └─ close the edges (renderer, HTTP validators file, IRS database)
```

Stages are pure functions. Edges (network, browser, LLM batches, SERP, D1) live outside
`src/stages/` and are called by the stage handlers in `src/run/handlers.ts`. A test fails if a file
in `src/stages/` imports `node:fs`, `node:net`, `node:http(s)`, `child_process`, `node:sqlite`,
`undici`, `playwright` or `yaml`, reads `process.env`, calls `Date.now()`, `new Date()` or `fetch(`.

## Stage contracts (`src/stages/`)

Every stage is `(ctx: Context, input: I) => { output: O; result: StageResult }`.

- `Context { now, caps, overrides, log, clock }` is built once in `cli.ts`. `now` is the run's
  logical time (`PIPELINE_NOW` or `--now` outside production); course-local "today" derives from
  it. `clock.nowMs()` is only for durations. `overrides` is the frozen result of `loadOverrides`.
- `StageResult { counters, budgetHits, errors, holds }`. Counter names are fixed in `COUNTERS`
  (`types.ts`): the `runs` columns plus summary-only ones such as `fetch_errors` (network and 5xx
  only, which drive the 20% rule).
- Paid or capped work takes `input.allowance` (remaining units per cap, from the guard). A stage
  that would go over stops, returns a `BudgetHit`, and the run continues.

| Stage name (`--stages`) | Function(s) | File | Input → output | Owner |
| --- | --- | --- | --- | --- |
| `discover` | `planSearch`, `discover` | `discover.ts` | metros, courses → `SerpQuery[]`; recheck, submissions, listing links, SERP results → `QueueEntry[]` | B |
| `fetch` | `planFetch` | `fetch-plan.ts` | `QueueEntry[]` → `FetchPlanItem[]` (render flag, caps); the `PageFetcher` port returns `FetchedPage` | B |
| `normalize` | `normalize` | `normalize.ts` | `FetchedPage[]` → `NormalizedPage[]` (text ≤ 12,000, JSON-LD, sha256, `unchanged`, `needs_render`) | B |
| `extract-request-build` | `extractRequestBuild` | `extract-request-build.ts` | `NormalizedPage[]` → `ExtractionRequest[]` + meta | C |
| `extract-collect` | `extractCollect` | `extract-collect.ts` | `BatchResult[]` + meta → `ExtractedPage[]` of `ExtractedEvent` | C |
| `classify` | `classify` | `classify.ts` | `ExtractedEvent[]` + `IrsLookup` → `ClassifiedOuting[]` | C |
| `match` | `match` | `match.ts` | `ClassifiedOuting[]` + course rows + places → `MatchedOuting[]` | C |
| `dedupe-upsert` | `dedupeUpsert` | `dedupe-upsert.ts` | `MatchedOuting[]` + existing rows → `UpsertPlan` + outcomes | C |
| `publish` | `publish` | `publish.ts` | outings + held sources → `PublishDecision[]` + `UpsertPlan` + IndexNow URLs | C |
| `recheck-roll-forward` | `recheckRollForward` | `recheck-roll-forward.ts` | outings + sources → `UpsertPlan` (past, roll forward, expected misses, source_gone) | C |
| `report` | `report` | `report.ts` | run row, stage statuses, holds by reason → Markdown, `failed` | A (done) |
| `courses` | `courses` | `courses.ts` | OSM features → course `UpsertPlan` (monthly) | D |
| `irs` | `irs` | `irs.ts` | BMF CSV rows → `IrsRecord[]` (monthly) | D |
| `course-types` | `courseTypesRequestBuild`, `courseTypesCollect` | `course-types.ts` | courses + pages → batch requests; results → course `UpsertPlan` (monthly) | D |

Every data shape that crosses a stage boundary has a zod schema in `types.ts` (`queueEntrySchema`,
`fetchedPageSchema`, `normalizedPageSchema`, `extractedEventSchema` (the shared extraction schema
plus cents, confidence and provenance), `classifiedOutingSchema`, `matchedOutingSchema`,
`upsertPlanSchema`, `publishDecisionSchema`, ...). `rows.ts` mirrors the D1 tables; a test compares
it with the migration, so a schema change without a migration fails.

### UpsertPlan

All writes are data: `{ ops: TableOp[] }`, applied in order. A `TableOp` is an `upsert` (rows,
conflict target defaulting to the primary key, `update` columns defaulting to every non-key
column, `[]` for DO NOTHING), an `update` (`set` and an equality `where`), or a `delete`. Rows are
validated against `rows.ts` before any SQL is written.

### Ports (edges)

Defined in `types.ts`, implemented outside `src/stages/`: `SerpAdapter` (DataForSEO, fixture
adapter for dry runs), `PageFetcher` (`fetchPage`, behind the SSRF guard and robots cache),
`ListingSource`, `BatchClient` (submit, poll, results), `IndexNowClient`, and `IrsLookup`
(read-only; `memoryIrsLookup` in `irs-memory.ts` for tests, a node:sqlite lookup from D). Every
paid or capped call goes through the `BudgetCheck` the handler passes in.

## Wiring (workstream E): what feeds each stage

`src/run/wire.ts` builds every handler. Each stage's input is the previous stage's output (carried in
`PipelineState`) plus rows read from the D1 snapshot; its output goes back into the state and its
`UpsertPlan` is applied by the runner right after the stage. Nightly order is the registry's.

| Stage | Inputs | Outputs |
| --- | --- | --- |
| `discover` | snapshot: due rechecks (published open/waitlist outings), unprocessed `submissions`, sources fetched in the last 7 days, held sources, `discovery_queue`, courses with outings or `notable`; `metros.yaml`; listing sources (series, platforms with `allowed: true`, association calendars, directories) through B's guarded fetcher; SERP results (DataForSEO live, fixture adapter in a dry run); `removals.yaml` (a removed URL is never queued, a removed outing never rechecked) | `state.queue`; submissions marked processed |
| `fetch` | `state.queue` → `planFetch` (caps, 40% recheck share, per-host cap, render flag) | `state.fetched`; `discovery_queue` bookkeeping (deferred, retries) |
| `normalize` | `state.fetched` + last collected `sources.content_hash` by URL; one headless render when the text is under 400 characters | `state.normalized` (`unchanged` when the hash matches) |
| `extract-request-build` | changed pages only; `sources.id` by URL (custom_id = source id) | `state.extractionRequests`, `state.extractionMeta` |
| `extract-collect` | the batch the latest nightly run that reached this stage left in `runs.pending_batch_id` (collected first; monthly rows are never read), then this run's requests: submit, poll every 60 s for up to 45 min; meta for an earlier run's results is rebuilt from its `sources` row | `state.extracted`; `runs.pending_batch_id` set when still running, cleared otherwise |
| `classify` | `state.extracted` events; IRS lookup (live: `ensureIrsDb` + `openIrsLookup` over `.cache/irs`; dry run: in-memory over `tests/fixtures/irs-subset.csv`) | `state.classified` |
| `match` | `state.classified`; snapshot courses and `cities` in the events' states | `state.matched` |
| `dedupe-upsert` | `state.matched`; snapshot outings on the matched courses, organizers, sources for this run's URLs, taken slugs; fetch outcomes; unchanged pages | `UpsertPlan` (organizers, sources, outings, source_outings, last_verified); `state.upsertOutcomes` |
| `publish` | every outing after the upserts with its course time zone and linked source URLs; held sources; this run's changed outing ids; `removals.yaml` | `UpsertPlan` (published, hold_reason); IndexNow ping (live with `INDEXNOW_KEY` only) |
| `recheck-roll-forward` | every outing with time zone and source URLs, every linked source, taken slugs | `UpsertPlan` (past, roll forward, expected misses, source_gone) |
| `report` | the `runs` row, stage statuses, summed counters, holds by reason from D1 | Markdown to stdout and `$GITHUB_STEP_SUMMARY`; exit code |

Rules the wiring keeps:

- **Content hash.** `sources.content_hash` is written only for pages whose extraction was collected
  in this run. A page whose batch is still running, whose result errored, or that a cap deferred is
  extracted again the next time it is fetched. Results collected from an earlier run's batch keep
  their `extracted_json` but not a hash (the hash of that page is not kept between runs).
- **Snapshot.** The live D1 snapshot is a working copy: every plan sent to D1 with
  `wrangler d1 execute --remote --file` is also applied to the local SQLite file, so publish and
  recheck read what dedupe-upsert wrote. The in-memory D1 is live by construction.
- **One batch client.** A live run builds one `AnthropicBatchClient` (`src/llm/batch-client.ts`)
  lazily and hands it to the extraction and, through `ports.batch`, to the monthly course types
  (`courseTypesHandler`), which also gets B's guarded fetcher through `ports.fetcher`.
- **Edges close at the end of the run**, not after normalize: the renderer, the HTTP validators
  file (`.cache/http-validators.json`) and the IRS database.

## Dry run on fixtures

```bash
PIPELINE_NOW=2026-09-28 pnpm run pipeline --dry-run --strict
```

What CI runs (`ci.yml`). Nothing touches the network (an undici dispatcher and a TCP guard refuse
every connection, and any attempt fails the run) and nothing costs money:

- **D1**: in-memory, migrated, loaded with the GeoNames places for the seed states and the 126
  courses from `tests/fixtures/courses.json` through the Phase 1 importer. No outings to start with.
  `--d1=local` uses the local wrangler D1 as it is instead (a seeded one turns the seed outings into
  updates rather than new rows).
- **Discovery**: B's listing sources over `tests/fixtures/discovery` plus one link per open,
  excluded or synthetic seed entry whose page fixture exists, with the entry's source kind; the
  fixture SERP adapter (still metered, so the SERP cap behaves as live).
- **Fetch**: `tests/fixtures/raw/{id}.html` at each page's URL; `pages/{id}.synthetic.json`
  stand-ins are served instead where present (gc1, gc5); s15 is served at
  `https://fixtures.invalid/s15-synthetic-oakmont-glendale`. Renders replay the same HTML.
- **LLM**: `tests/fixtures/llm/{id}.json` replayed by custom_id (`sourceIdForUrl` of the fixture
  page's URL). Pages without a recording come back `errored (fixture_missing)` and are listed under
  Errors; the run still passes.
- **IRS**: in-memory lookup over `tests/fixtures/irs-subset.csv`.

With `PIPELINE_NOW=2026-09-28` the run reports 16 URLs queued, 17 fetches, 14 pages normalized, 14
extraction requests, 13 events extracted, 1 excluded (gc1), 3 held (azgolf calendar entries with no
matching course), 9 new outings, all published, and `2026/nkf-golf-classic-winged-foot` labelled
"Charity". `tests/dry-run.test.ts` runs the same thing in process and asserts it.

## Caps and failure rules

Each is a test in `tests/caps.test.ts` and can be run by hand:

```bash
# Search stops at 5 queries, a MAX_SERP_QUERIES_PER_RUN hit is recorded, every other stage completes.
PIPELINE_NOW=2026-09-28 MAX_SERP_QUERIES_PER_RUN=5 pnpm run pipeline --dry-run --strict
# fetch throws, later stages are skipped, the runs row keeps the error, exit 1.
PIPELINE_NOW=2026-09-28 pnpm run pipeline --dry-run --fail-stage=fetch
```

- The 20% rule counts only network errors, timeouts and 5xx (`COUNTS_AS_FETCH_ERROR`); 404, 410
  and robots blocks never count.
- At or over `MONTHLY_SPEND_CAP_CENTS` (summed over this calendar month's `runs` rows in the
  snapshot, remote in a live run), SERP and LLM work is skipped with a budget hit and the free
  stages still run.
- A batch still running after 45 minutes is stored in `runs.pending_batch_id`; the next nightly run
  collects it before submitting anything new.

## Live runs

```bash
pnpm run pipeline --live --budget=nightly   # nightly.yml, 07:15 UTC
pnpm run pipeline --live --budget=smoke     # the owner's first live run: every cap at 5 to 10
pnpm run pipeline --live --budget=monthly --stages=courses,irs,course-types   # monthly.yml
```

Before anything else a live run validates its environment with the shared zod schema and refuses to
start (exit 2, nothing fetched, sent or written, no `runs` row) when a secret is missing or
`apps/site/wrangler.toml` still has the placeholder `database_id` (or one that differs from
`D1_DATABASE_ID`). Nightly needs `PUBLIC_SITE_URL`, `ANTHROPIC_API_KEY`, `SERP_API_KEY`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `D1_DATABASE_ID`; monthly needs the same minus
`SERP_API_KEY`. With `--llm=claude-cli` the run needs no `ANTHROPIC_API_KEY`, with `--serp=claude-search`
no `SERP_API_KEY`, and with `--d1=local` no Cloudflare secrets (the user agent falls back to the dev URL
outside production). `INDEXNOW_KEY` is optional; without it publish logs the URLs it would have pinged.
The snapshot comes from `wrangler d1 export --remote`, writes go out with
`wrangler d1 execute --remote --file`.

`--budget=smoke` caps (any env var of the same name still overrides): 5 SERP queries, 10
extractions, 60,000 input tokens, 10 fetches, 5 renders, 5 fetches per host, 10 fetch minutes, no
course classifications, and the usual `MONTHLY_SPEND_CAP_CENTS`. It runs the nightly stages and
writes a `nightly` runs row; at most a few cents. In Actions: run the nightly workflow by hand and
pick `smoke`.

## Subscription-backed providers (`--llm=claude-cli`, `--serp=claude-search`)

For running locally on the owner's Claude subscription instead of API credits. Both spawn Claude
Code headless (`claude -p`, checked against 2.1.289) and never run in tests or dry runs (tests pass
a fake spawner; a dry run refuses the flags and replays fixtures).

| | `--llm=claude-cli` (`src/llm/claude-cli.ts`) | `--serp=claude-search` (`src/serp/claude-search.ts`) |
| --- | --- | --- |
| Interface | `BatchClient` (extraction and course types share one) | `BatchSerpAdapter` |
| Per call | one `claude -p` per request, page text on stdin | one `claude -p` per query, query text on stdin |
| Model | `claude-haiku-4-5` | `claude-haiku-4-5` |
| Prompt | `--system-prompt` = prompts/extract.md (or course-type.md) | `--system-prompt` asking for the top organic results |
| Output | `--json-schema` = the request's schema; `structured_output`, else a fenced JSON block in `result`; zod either way | `--json-schema` `{results:[{url,title,snippet}]}` (max 10), zod, URLs normalized |
| Tools | none (`--tools ""` and every tool in `--disallowedTools`) | WebSearch only |
| Limits | 120 s timeout, 2 retries (2 s, 8 s), `CLAUDE_CLI_CONCURRENCY` (default 3) | same |
| Caps | `MAX_EXTRACTIONS_PER_RUN`, `MAX_LLM_INPUT_TOKENS_PER_RUN` (estimate before submit, then actual usage) | `MAX_SERP_QUERIES_PER_RUN` before every spawn |

Details that matter:

- **No `--bare`.** Bare mode authenticates only with `ANTHROPIC_API_KEY`, so it cannot use the
  subscription ("Not logged in"). Instead: `--safe-mode` (no CLAUDE.md, hooks, plugins, MCP servers),
  `--strict-mcp-config`, `--no-session-persistence`, an empty working directory, and our prompt as
  `--system-prompt` in place of Claude Code's.
- **No secrets in the child.** `ANTHROPIC_API_KEY` and every other secret are removed from its
  environment, so it can't fall back to API billing.
- **Thinking off** (`MAX_THINKING_TOKENS=0` in the child). With Claude Code's default thinking, one
  fixture page took 46 s and 5,536 output tokens; without it, 7 s and 667, the same as the Batches
  path asks for.
- **Fatal answers stop the client** ("Not logged in", the usage limit): nothing more is spawned, the
  remaining requests come back errored and their pages stay queued for the next run.
- **Tokens.** Claude Code adds its own overhead (the structured-output tool carries the schema), so
  actual input runs above the estimate. The guard is charged the estimate before submit, the client
  stops once actual usage reaches what the cap had left, and the difference is added to the meter.
- **Pending batches** don't exist: `submit` returns when every request is answered. A Message Batches
  id left pending by an earlier API run is left alone (logged).
- **Cost.** `est_cost_cents` still uses the SPEC.md 14 API rates (so the monthly spend cap still
  counts it). The report's cost line says the estimate was covered by subscription and adds Claude
  Code's own `total_cost_usd` sum (API list prices) as a usage proxy.
- **Search quality.** WebSearch is not Google organic; result order is the model's reading of the
  tool's results, and it often returns fewer than 10. A made-up URL just 404s at fetch.
- `--prioritize-states=NY,NJ,CT` puts those states' metros and courses into tonight's search plan
  whatever their spread night, ahead of the rest; the cap cuts from the end.

## How B, C and D plug in

1. Replace the stub export in your stage file (`export const classify: ClassifyStage =
   notImplemented("classify")`) with the real function. Keep the name and type. `isImplemented`
   turns true and the golden tests gated on that stage start running.
2. Put edges (fetcher, SERP adapter, batch client, IRS database) outside `src/stages/`, behind the
   port interfaces in `types.ts`.
3. Write tests first. Golden cases live in `tests/golden/golden.test.ts`; the harness gates each
   one on the stages it uses and, for LLM-backed checks, on `tests/fixtures/llm/{id}.json`.
4. Workstream E wired the handlers (`src/run/wire.ts`, above) and turned on `--strict` in CI and
   the workflows.

Budget accounting: the `BudgetGuard` is the only meter. Edges call `guard.check(cap, n, stage)`
before each paid or capped call (it records a hit and returns false at the cap, never throws);
`guard.checkHost(host)` for the per-host cap; `guard.checkFetchMinutes()` for `MAX_FETCH_MINUTES`.
When a pure stage plans paid work within its allowance, its handler consumes the guard for what it
submits. The `runs` meter columns come from the guard; `outings_new`, `outings_updated` and
`outings_held` are summed from stage counters. Before each paid stage the runner checks
`MONTHLY_SPEND_CAP_CENTS` against this calendar month's `runs` plus this run; at or over it, every
paid meter is blocked and a hit is recorded, and free work continues.

## Fixture layout

```
seed/outings.json                         32 seed entries with expected_* fields (golden cases gc1..gc8)
tests/fixtures/pages/{id}.json            normalized pages recorded in Phase 0: { url, fetched_at, http_status, text, jsonld }
tests/fixtures/pages/{id}.synthetic.json  hand-written stand-ins (synthetic: true, note); preferred when present
                                          s14 (gc1, page gone) and s12 (gc5, login wall)
tests/fixtures/raw/{id}.html              raw HTML from Phase 0
tests/fixtures/llm/{id}.json              Message Batches results for gc1..gc8 (s01, s02, s04, s06, s12..s15):
                                          { id, recorded, note?, recorded_at, model, extractor_version, batch_result }
                                          hand-written (`recorded: false`) until the owner approves
                                          `pnpm run test:live-extract`, which writes `recorded: true`
tests/fixtures/discovery/                 hand-written listing pages and sitemaps (index.json maps URL → file)
tests/fixtures/serp/*.json                DataForSEO task_get responses by query text
tests/fixtures/course-types/              course-type pages and batch results for the monthly dry run
tests/fixtures/courses.json               recorded Overpass subset (© OpenStreetMap contributors)
tests/fixtures/irs-subset.csv             synthetic IRS BMF rows (28 BMF columns; see irs-subset.README.md)
tests/fixtures/MISSING.md                 pages that could not be recorded
```

`tests/golden/harness.ts` loads all of these, pins `now` to 2026-09-28, and logs when it uses a
synthetic page or finds no recording. `tests/golden/chain.ts` runs an entry through
extract-request-build, extract-collect (with the recording), classify and match.

## CLI

```bash
pnpm run pipeline --dry-run                       # default: fixtures, network blocked, in-memory D1
pnpm run pipeline --dry-run --strict              # what CI runs (with PIPELINE_NOW=2026-09-28)
pnpm run pipeline --live --budget=nightly         # nightly.yml
pnpm run pipeline --live --budget=smoke           # first live run: every cap at 5 to 10
pnpm run pipeline --live --budget=monthly --stages=courses,irs,course-types   # monthly.yml
pnpm run pipeline --dry-run --stages=classify,match
pnpm run pipeline --dry-run --fail-stage=fetch    # throw inside a stage (Phase 5 alert test)
pnpm run pipeline --dry-run --weekly-report       # render the weekly report issue body into the summary
pnpm run pipeline --dry-run --now=2026-09-28      # pin the clock (refused when NODE_ENV=production)
pnpm run pipeline --dry-run --d1=local            # the local wrangler D1 instead of the in-memory one
```

| Flag | Meaning |
| --- | --- |
| `--dry-run` | Default. Installs an undici global dispatcher that refuses every request (Node's fetch included) and a TCP connect guard; any attempt fails the run. Uses an in-memory D1 loaded with the fixture places and courses. |
| `--live` | Real run against the remote D1, after the preflight. Paid APIs only here and in `pnpm run test:live-extract`. |
| `--budget=nightly\|monthly\|smoke` | Cap profile from SPEC.md 14 (smoke: every cap at 5 to 10); env vars of the same name override each cap. `runs.kind` is `monthly` for monthly, `nightly` otherwise. |
| `--stages=a,b,c` | Run only these, in run order; `report` always runs last. |
| `--fail-stage=<name>` | Throw inside that stage. |
| `--now=<ISO>` | Pin the clock like `PIPELINE_NOW`; refused when `NODE_ENV=production`. |
| `--strict` | A `NotImplemented` stage fails the run. |
| `--d1=local\|remote\|memory`, `--persist-to=<dir>` | D1 target (dry run: `memory`, live: `remote`); a dry run never writes the remote one. `--live --d1=local` needs no Cloudflare secrets. |
| `--llm=api\|claude-cli` | LLM provider (`LLM_PROVIDER`; default `api`). `claude-cli` needs no `ANTHROPIC_API_KEY`. Live only. |
| `--serp=dataforseo\|claude-search\|fixture` | SERP provider (`SERP_PROVIDER`; default `dataforseo` live). `claude-search` needs no `SERP_API_KEY`. Live only. |
| `--prioritize-states=NY,NJ,CT` | Search those states' metros and courses tonight, first. |
| `--recheck-all` | Recheck every published open or waitlist outing tonight, due or not, within the 40% recheck share (oldest `last_verified` first). Useful after an extractor version bump. |
| `--weekly-report` | Create or update the weekly report issue tonight even if it isn't Monday (live nightly on the remote D1 only); a dry run renders it into the summary. |

Exit codes: 0 OK; 1 when a stage throws, `--fail-stage` fired, more than 20% of fetches errored
(network and 5xx only), a dry run tried the network, or `--strict` met a stub; 2 on a usage error or
a refused live preflight.
The `runs` row is written at start and after every stage (`stages_done`, counters, `budget_hits`,
`errors`, `est_cost_cents` from the SPEC.md 14 rates, `pending_batch_id`), so a killed job still
leaves a record. The report lists stage statuses, counts, holds by reason across `sources` and
`outings`, budget hits and errors (with the page URL when there is one) and the estimated cost, and
is appended to `$GITHUB_STEP_SUMMARY` when set. The logger redacts secret env values.

**Weekly report issue** (`src/report/`, `src/run/weekly.ts`, SPEC.md 8.10). After the report, a
live nightly run against the remote D1 on a Monday (UTC date), or with `--weekly-report`, reads the
last 7 days of `runs`, holds by reason, published counts and this month's spend, and creates or
updates the one open issue titled "Weekly pipeline report" (found by the `pipeline-report` label,
then by exact title). It needs `GH_TOKEN` and `GITHUB_REPOSITORY` (Actions sets both in
nightly.yml) and talks to api.github.com with `X-GitHub-Api-Version: 2026-03-10`; every response
is zod-validated. GET and PATCH are retried on 5xx, 429 and network errors; POST never is, so a
timeout can't open a second issue. A dry run renders the body into the summary and sends nothing.
A GitHub failure is logged, shown in the summary and stored as a `report` error on the `runs` row,
and never changes the exit code.

## D1 edge (`src/d1/`)

`D1Port { snapshot(), apply(plan), query(sql, schema) }`. `WranglerD1` exports with
`wrangler d1 export --remote|--local --output`, loads the dump into `.cache/d1/<run id>/snapshot.sqlite`
in one transaction and reads it with node:sqlite; `apply` renders the plan as literal-value SQL
(at most 50 rows per statement, under 100 KB each, at most 1,000 statements per file) and runs
`wrangler d1 execute --file`, then applies the same statements to the snapshot file (write-through).
Credentials come from `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment, never the command line. Remote commands read
`apps/site/wrangler.toml`, so its `database_id` must hold the real id (an owner task in the root
README) before a live run. `MemoryD1` runs the same SQL on
an in-memory node:sqlite database with the migrations applied; tests use it, and never call the
wrangler paths.
