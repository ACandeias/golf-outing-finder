# @gof/pipeline

The nightly and monthly pipeline (SPEC.md section 8) and the Phase 1 loaders. This page covers the
Phase 2 skeleton: stage contracts, how workstreams B, C and D plug in, the fixture layout and the
CLI.

## Shape of a run

```
cli.ts ─ parse args, block the network (dry run), build Context once, open the D1 port
  └─ run/runner.ts
       ├─ write the runs row (start)
       ├─ D1 snapshot (wrangler d1 export → SQLite file, read with node:sqlite)
       ├─ BudgetGuard (caps + this month's runs for MONTHLY_SPEND_CAP_CENTS)
       ├─ for each stage: handler → edges (ports) + pure stage → UpsertPlan → d1.apply → update runs row
       └─ report stage → stdout and $GITHUB_STEP_SUMMARY → exit code
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

## How B, C and D plug in

1. Replace the stub export in your stage file (`export const classify: ClassifyStage =
   notImplemented("classify")`) with the real function. Keep the name and type. `isImplemented`
   turns true and the golden tests gated on that stage start running.
2. Put edges (fetcher, SERP adapter, batch client, IRS database) outside `src/stages/`, behind the
   port interfaces in `types.ts`.
3. Write tests first. Golden cases live in `tests/golden/golden.test.ts`; the harness gates each
   one on the stages it uses and, for LLM-backed checks, on `tests/fixtures/llm/{id}.json`.
4. Workstream E replaces `defaultHandlers` (`src/run/handlers.ts`) with handlers that read the
   snapshot, call the ports and pass the stage outputs along `PipelineState`, and turns on
   `--strict` in the workflows.

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
tests/fixtures/llm/{id}.json              recorded Message Batches results (none yet; owner-gated):
                                          { id, recorded_at, model, extractor_version, batch_result }
tests/fixtures/courses.json               recorded Overpass subset (© OpenStreetMap contributors)
tests/fixtures/irs-subset.csv             synthetic IRS BMF rows (28 BMF columns; see irs-subset.README.md)
tests/fixtures/MISSING.md                 pages that could not be recorded
```

`tests/golden/harness.ts` loads all of these, pins `now` to 2026-09-28, and logs when it uses a
synthetic page or finds no recording. `tests/golden/chain.ts` runs an entry through
extract-request-build, extract-collect (with the recording), classify and match.

## CLI

```bash
pnpm run pipeline --dry-run                       # default: fixtures, network blocked, local D1
pnpm run pipeline --dry-run --strict              # unimplemented stages fail the run (E turns this on)
pnpm run pipeline --live --budget=nightly         # nightly.yml
pnpm run pipeline --live --budget=monthly --stages=courses,irs,course-types   # monthly.yml
pnpm run pipeline --dry-run --stages=classify,match
pnpm run pipeline --dry-run --fail-stage=fetch    # throw inside a stage (Phase 5 alert test)
pnpm run pipeline --dry-run --now=2026-09-28      # pin the clock (refused when NODE_ENV=production)
pnpm run pipeline --dry-run --d1=memory           # in-memory D1 instead of the local one
```

| Flag | Meaning |
| --- | --- |
| `--dry-run` | Default. Installs an undici global dispatcher that refuses every request (Node's fetch included) and a TCP connect guard; any attempt fails the run. Uses the local D1 (`wrangler d1 ... --local`). |
| `--live` | Real run against the remote D1. Paid APIs only here and in `pnpm run test:live-extract`. |
| `--budget=nightly\|monthly` | Cap profile from SPEC.md 14; env vars of the same name override each cap. Also the `runs.kind`. |
| `--stages=a,b,c` | Run only these, in run order; `report` always runs last. |
| `--fail-stage=<name>` | Throw inside that stage. |
| `--now=<ISO>` | Pin the clock like `PIPELINE_NOW`; refused when `NODE_ENV=production`. |
| `--strict` | A `NotImplemented` stage fails the run. |
| `--d1=local\|remote\|memory`, `--persist-to=<dir>` | D1 target; a dry run never writes the remote one. |

Exit codes: 0 OK; 1 when a stage throws, `--fail-stage` fired, more than 20% of fetches errored
(network and 5xx only), a dry run tried the network, or `--strict` met a stub; 2 on a usage error.
The `runs` row is written at start and after every stage (`stages_done`, counters, `budget_hits`,
`errors`, `est_cost_cents` from the SPEC.md 14 rates, `pending_batch_id`), so a killed job still
leaves a record. The report lists stage statuses, counts, holds by reason across `sources` and
`outings`, budget hits and errors, and is appended to `$GITHUB_STEP_SUMMARY` when set. The logger
redacts secret env values.

## D1 edge (`src/d1/`)

`D1Port { snapshot(), apply(plan), query(sql, schema) }`. `WranglerD1` exports with
`wrangler d1 export --remote|--local --output`, loads the dump into `.cache/d1/<run id>/snapshot.sqlite`
in one transaction and reads it with node:sqlite; `apply` renders the plan as literal-value SQL
(at most 50 rows per statement, under 100 KB each, at most 1,000 statements per file) and runs
`wrangler d1 execute --file`. Credentials come from `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment, never the command line. Remote commands read
`apps/site/wrangler.toml`, so its `database_id` must hold the real id (an owner task in the root
README) before a live run. `MemoryD1` runs the same SQL on
an in-memory node:sqlite database with the migrations applied; tests use it, and never call the
wrangler paths.
