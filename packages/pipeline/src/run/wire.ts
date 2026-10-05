import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, SerpProvider } from "@gof/shared/env";
import { z } from "zod";
import { courseTypesHandler } from "../courses/course-types-handler.ts";
import { coursesHandler } from "../courses/monthly.ts";
import type { Snapshot } from "../d1/port.ts";
import { hostOf } from "../discovery/url.ts";
import { sha256Hex } from "../extract/ids.ts";
import { EXTRACTOR_VERSION } from "../extract/prompt.ts";
import { discoverHandler, fetchHandler, fetchSide, normalizeHandler } from "../fetch/handlers.ts";
import { loadFixtureDocs } from "../fetch/fixture-fetch.ts";
import { createFetchSidePorts, type FetchSidePorts } from "../fetch/ports.ts";
import { indexNowClient } from "../indexnow/client.ts";
import { openIrsLookup, type SqliteIrsLookup } from "../irs/db.ts";
import { ensureIrsDb } from "../irs/ensure.ts";
import { IRS_CACHE_DIR, IRS_FIXTURE_CSV, irsHandler } from "../irs/handler.ts";
import { AnthropicBatchClient, MAX_WAIT_MS, POLL_INTERVAL_MS, runExtractionBatch } from "../llm/batch-client.ts";
import { ClaudeCliBatchClient, DEFAULT_CONCURRENCY, type ClaudeSpawner } from "../llm/claude-cli.ts";
import { estimateCostCents } from "../budget.ts";
import { createClaudeSearchAdapter, type ClaudeSearchAdapter } from "../serp/claude-search.ts";
import { platformRulesFrom } from "../discovery/platform-policy.ts";
import { loadPlatforms } from "../discovery/sources.ts";
import { PATHS } from "../lib/paths.ts";
import { sqlValue } from "../sql/literal.ts";
import { classify } from "../stages/classify.ts";
import { dedupeUpsert } from "../stages/dedupe-upsert.ts";
import { extractCollect } from "../stages/extract-collect.ts";
import { extractRequestBuild } from "../stages/extract-request-build.ts";
import { match } from "../stages/match.ts";
import { publish } from "../stages/publish.ts";
import { recheckRollForward } from "../stages/recheck-roll-forward.ts";
import {
  courseRowSchema,
  outingRowSchema,
  sourceKindSchema,
  sourceRowSchema,
} from "../stages/rows.ts";
import {
  emptyResult,
  placeCitySchema,
  type BatchClient,
  type BatchResult,
  type BudgetCheck,
  type Context,
  type DedupeUpsertInput,
  type ExtractedPage,
  type ExtractionRequestMeta,
  type IndexNowClient,
  type IrsLookup,
  type OutingRow,
  type PageFetcher,
  type Ports,
  type StageResult,
  type TableOp,
} from "../stages/types.ts";
import {
  concatListings,
  fixtureExtractionClient,
  fixtureIrsLookup,
  seedListingSource,
} from "./fixture-world.ts";
import type { HandlerOutcome, StageEnv, StageHandlers } from "./handlers.ts";

/**
 * The nightly wiring (workstream E): every stage's input built from the
 * previous stage's output (PipelineState) and the D1 snapshot, along the
 * contracts in src/stages/types.ts, with the edges created once per run.
 *
 *   discover ─ fetch ─ normalize            workstream B's handlers (src/fetch/handlers.ts)
 *   extract-request-build                   changed pages → requests; custom_id = source id
 *   extract-collect                         pending batch from the last nightly run first,
 *                                           then submit, poll 60 s up to 45 min, validate
 *   classify ─ match                        IRS lookup; courses and cities from the snapshot
 *   dedupe-upsert                           existing rows + fetch outcomes → UpsertPlan
 *   publish                                 every outing after the upserts → decisions, IndexNow
 *   recheck-roll-forward                    every outing and its sources → past, roll forward
 *
 * The monthly stages keep workstream D's handlers; in a live run they get the
 * same Anthropic batch client and B's guarded fetcher through `ports`.
 */

export interface PollSettings {
  sleep: (ms: number) => Promise<void>;
  intervalMs: number;
  maxWaitMs: number;
  nowMs: () => number;
}

export interface RunEdges {
  readonly mode: "dry-run" | "live";
  /** B's fetcher, renderer, listing source and SERP adapter, built on first use. */
  fetchSide(): Promise<FetchSidePorts>;
  /** The Message Batches client the extraction uses. */
  extractionBatch(): BatchClient;
  /** IRS lookup for classify (opened on first use, closed by `close`). */
  irs(guard: BudgetCheck): Promise<{ lookup: IrsLookup; error: string | null }>;
  /** IndexNow pings; null in a dry run or without INDEXNOW_KEY. */
  indexnow(): IndexNowClient | null;
  /** What every handler sees as `env.ports` (D's course-types reads batch and fetcher). */
  ports(): Partial<Ports>;
  readonly poll: PollSettings;
  /** Closes the renderer, saves HTTP validators, closes the IRS database. */
  close(): Promise<void>;
  /** `--llm`: where extraction and course-type calls go. */
  readonly llm: LlmProvider;
  /** `--serp`: where search queries go. */
  readonly serp: SerpProvider;
  /** The claude-cli client when `llm` is claude-cli (stats, token limit); else null. */
  claudeCli(): ClaudeCliBatchClient | null;
  /** The claude-search adapter once built, when `serp` is claude-search; else null. */
  claudeSearch(): ClaudeSearchAdapter | null;
  /**
   * The report's cost line when a subscription-backed provider ran: the API-rate
   * estimate is covered by the subscription. Null for API-only runs.
   */
  costNote(estCostCents: number): string | null;
}

export interface RunEdgesOptions {
  ctx: Context;
  mode: "dry-run" | "live";
  env: Readonly<Record<string, string | undefined>>;
  /** Test doubles; anything left out is built from `mode` and `env`. */
  fetchSide?: FetchSidePorts;
  /** Wraps the fetch-side edges after they are built (tests inject fetch outcomes). */
  decorateFetchSide?: (ports: FetchSidePorts) => FetchSidePorts;
  extractionBatch?: BatchClient;
  liveBatch?: BatchClient;
  irs?: IrsLookup;
  indexnow?: IndexNowClient | null;
  poll?: Partial<PollSettings>;
  /** `--llm` (default api). Only a live run uses it; a dry run always replays fixtures. */
  llm?: LlmProvider;
  /** `--serp` (default dataforseo live, fixture dry run). */
  serp?: SerpProvider;
  /** `--prioritize-states`, handed to the search plan. */
  prioritizeStates?: readonly string[];
  /** Test double for `claude -p` (claude-cli and claude-search); never a real process in tests. */
  claudeSpawner?: ClaudeSpawner;
}

/** A BatchClient that constructs the real one on first use (no SDK client unless a batch is sent). */
function lazyBatch(make: () => BatchClient): BatchClient {
  let c: BatchClient | null = null;
  const get = (): BatchClient => (c ??= make());
  return {
    submit: (r) => get().submit(r),
    poll: (id) => get().poll(id),
    results: (id) => get().results(id),
  };
}

function botUserAgent(env: Readonly<Record<string, string | undefined>>): string {
  const site = env.PUBLIC_SITE_URL ?? "http://localhost:8787";
  return `GolfOutingFinderBot/1.0 (+${site.replace(/\/$/, "")}/bot)`;
}

function claudeConcurrency(env: Readonly<Record<string, string | undefined>>): number {
  const n = Number(env.CLAUDE_CLI_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : DEFAULT_CONCURRENCY;
}

export function createRunEdges(o: RunEdgesOptions): RunEdges {
  const { ctx, mode, env } = o;
  const llm: LlmProvider = mode === "live" ? (o.llm ?? "api") : "api";
  const serp: SerpProvider = mode === "live" ? (o.serp ?? "dataforseo") : "fixture";
  const concurrency = claudeConcurrency(env);
  let cliClient: ClaudeCliBatchClient | null = null;
  const claudeCliClient = (): ClaudeCliBatchClient =>
    (cliClient ??= new ClaudeCliBatchClient({
      ...(o.claudeSpawner ? { spawner: o.claudeSpawner } : {}),
      concurrency,
      log: ctx.log,
    }));
  let searchAdapter: ClaudeSearchAdapter | null = null;
  const claudeSearchAdapter = (): ClaudeSearchAdapter =>
    (searchAdapter ??= createClaudeSearchAdapter({
      ...(o.claudeSpawner ? { spawner: o.claudeSpawner } : {}),
      concurrency,
      log: ctx.log,
    }));
  let side: Promise<FetchSidePorts> | null = o.fetchSide ? Promise.resolve(o.fetchSide) : null;
  let sideBuilt = false;
  let irsOpen: SqliteIrsLookup | null = null;
  let irsMemo: Promise<{ lookup: IrsLookup; error: string | null }> | null = null;

  const fetchSidePorts = (): Promise<FetchSidePorts> => {
    side ??= (async () => {
      sideBuilt = true;
      const built = await createFetchSidePorts(ctx, mode, env, {
        serp,
        ...(mode === "live" && serp === "claude-search" ? { serpAdapter: claudeSearchAdapter() } : {}),
      });
      // Dry run: the seed pages stand in for what discovery would have found.
      const withSeed =
        mode === "live"
          ? built
          : { ...built, listings: concatListings(built.listings, await seedListingSource(loadFixtureDocs())) };
      const ports: FetchSidePorts =
        o.prioritizeStates && o.prioritizeStates.length > 0
          ? { ...withSeed, prioritizeStates: [...o.prioritizeStates] }
          : withSeed;
      return o.decorateFetchSide ? o.decorateFetchSide(ports) : ports;
    })();
    return side;
  };

  // One batch client per live run, shared by extraction and course types: the
  // Message Batches API, or `claude -p` on the subscription (--llm=claude-cli).
  const liveBatch: BatchClient =
    o.liveBatch ??
    (llm === "claude-cli" ? claudeCliClient() : lazyBatch(() => new AnthropicBatchClient(new Anthropic())));
  let extraction: BatchClient | null = o.extractionBatch ?? null;

  const poll: PollSettings = {
    sleep: o.poll?.sleep ?? (mode === "live" ? (ms) => new Promise((r) => setTimeout(r, ms)) : async () => {}),
    intervalMs: o.poll?.intervalMs ?? POLL_INTERVAL_MS,
    maxWaitMs: o.poll?.maxWaitMs ?? MAX_WAIT_MS,
    nowMs: o.poll?.nowMs ?? (() => ctx.clock.nowMs()),
  };

  let indexnow: IndexNowClient | null | undefined = o.indexnow;
  const indexnowClient = (): IndexNowClient | null => {
    if (indexnow !== undefined) return indexnow;
    const key = env.INDEXNOW_KEY;
    const site = env.PUBLIC_SITE_URL;
    indexnow =
      mode === "live" && key && site
        ? indexNowClient({ siteUrl: site, key }, async (url, init) => {
            const res = await fetch(url, init);
            return { ok: res.ok, status: res.status };
          })
        : null;
    return indexnow;
  };

  // Live: course types fetch through B's guarded fetcher (robots, SSRF guard, host spacing).
  const liveFetcher: PageFetcher = {
    fetchPage: async (item, budget) => (await fetchSidePorts()).fetcher.fetchPage(item, budget),
  };

  return {
    mode,
    fetchSide: fetchSidePorts,
    extractionBatch() {
      extraction ??= mode === "live" ? liveBatch : fixtureExtractionClient();
      return extraction;
    },
    irs(guard) {
      irsMemo ??= (async () => {
        if (o.irs) return { lookup: o.irs, error: null };
        if (mode === "dry-run") return { lookup: fixtureIrsLookup(ctx, IRS_FIXTURE_CSV), error: null };
        try {
          const res = await ensureIrsDb({
            ctx,
            dir: IRS_CACHE_DIR,
            mode,
            fixturePath: IRS_FIXTURE_CSV,
            http: { userAgent: botUserAgent(env) },
            allowFetch: () => guard.check("MAX_FETCHES_PER_RUN", 1, "classify"),
          });
          irsOpen = openIrsLookup(res.path);
          return { lookup: irsOpen, error: res.error };
        } catch (err) {
          // No cached database and no download: classify still runs, every charity unverified.
          return {
            lookup: { byEin: () => null, candidates: () => [] },
            error: `IRS lookup unavailable: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      })();
      return irsMemo;
    },
    indexnow: indexnowClient,
    ports() {
      if (mode === "dry-run") return {};
      const p: Partial<Ports> = { batch: liveBatch, fetcher: liveFetcher };
      const ix = indexnowClient();
      if (ix) p.indexnow = ix;
      return p;
    },
    poll,
    llm,
    serp,
    claudeCli: () => (llm === "claude-cli" && !o.liveBatch ? claudeCliClient() : null),
    claudeSearch: () => searchAdapter,
    costNote(estCostCents) {
      if (llm !== "claude-cli" && serp !== "claude-search") return null;
      const parts: string[] = [];
      let proxy = 0;
      if (llm === "claude-cli" && cliClient) {
        const s = cliClient.stats();
        proxy += s.cost_usd;
        parts.push(
          `LLM: claude -p, ${s.succeeded} of ${s.requests} requests answered, ${s.input_tokens} input and ${s.output_tokens} output tokens` +
            ` (${(estimateCostCents({ llm_input_tokens: s.input_tokens, llm_output_tokens: s.output_tokens, serp_queries: 0 }) / 100).toFixed(2)} USD at Batch API rates)`,
        );
      }
      if (serp === "claude-search" && searchAdapter) {
        const s = searchAdapter.stats();
        proxy += s.cost_usd;
        parts.push(`search: claude -p WebSearch, ${s.succeeded} of ${s.queries} queries answered, ${s.results} results`);
      }
      return (
        `Estimated cost at API rates: $${(estCostCents / 100).toFixed(2)}, covered by subscription (Claude Code headless). ` +
        `${parts.join("; ")}${parts.length ? ". " : ""}` +
        `Claude Code's own total_cost_usd for these calls (API list prices, a usage proxy): $${proxy.toFixed(2)}.`
      );
    },
    async close() {
      if (side && (sideBuilt || o.fetchSide)) await (await side).close();
      irsOpen?.close();
      irsOpen = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot reads
// ---------------------------------------------------------------------------

/** `IN (...)` over literal values; an empty list matches nothing. */
function inList(values: Iterable<string>): string {
  const v = [...new Set(values)];
  return v.length === 0 ? "(NULL)" : `(${v.map((x) => sqlValue(x)).join(", ")})`;
}

const idUrl = z.object({ id: z.string(), url: z.string() });
const slugRow = z.object({ slug: z.string() });
const tzRow = z.object({ id: z.string(), time_zone: z.string() });
const linkRow = z.object({ outing_id: z.string(), url: z.string() });
const organizerRow = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  ein: z.string().nullable(),
  charity_status: z.enum(["501c3", "other_nonprofit", "unverified"]),
});
const pendingRunRow = z.object({
  id: z.string(),
  pending_batch_id: z.string().nullable(),
  stages_done: z.string(),
});

/** Outings with their course's time zone and every linked source URL (publish, recheck). */
function outingsWithContext(snapshot: Snapshot): {
  outing: OutingRow;
  time_zone: string;
  source_urls: string[];
}[] {
  const tz = new Map(
    snapshot.all("SELECT id, time_zone FROM courses WHERE id IN (SELECT course_id FROM outings)", tzRow).map(
      (r) => [r.id, r.time_zone] as const,
    ),
  );
  const urls = new Map<string, string[]>();
  for (const l of snapshot.all(
    "SELECT so.outing_id AS outing_id, s.url AS url FROM source_outings so JOIN sources s ON s.id = so.source_id",
    linkRow,
  )) {
    urls.set(l.outing_id, [...(urls.get(l.outing_id) ?? []), l.url]);
  }
  return snapshot
    .all("SELECT * FROM outings ORDER BY id", outingRowSchema)
    .filter((o) => tz.has(o.course_id))
    .map((o) => ({ outing: o, time_zone: tz.get(o.course_id) ?? "UTC", source_urls: urls.get(o.id) ?? [] }));
}

/**
 * The batch an earlier nightly run left waiting: the `pending_batch_id` of the
 * latest other nightly run that got through extract-collect (a run killed
 * before that stage never decided, so the one before it still speaks). Monthly
 * rows are the course-types batch and are never read here.
 */
export function pendingNightlyBatch(snapshot: Snapshot, runId: string): string | null {
  for (const r of snapshot.all(
    `SELECT id, pending_batch_id, stages_done FROM runs WHERE kind = 'nightly' AND id <> ${sqlValue(runId)} ORDER BY started_at DESC, id DESC`,
    pendingRunRow,
  )) {
    let done: unknown;
    try {
      done = JSON.parse(r.stages_done);
    } catch {
      continue;
    }
    if (Array.isArray(done) && done.includes("extract-collect")) return r.pending_batch_id;
  }
  return null;
}

/** A marker hash for results collected from an earlier run's batch: the page's hash is unknown here. */
export const UNKNOWN_HASH = sha256Hex("gof:pending-batch:hash-unknown");

/**
 * Meta for results whose request was built by an earlier run (a pending batch):
 * rebuilt from the `sources` row whose id is the custom_id. Its JSON-LD events
 * are not kept between runs, and its content hash stays unwritten so the page
 * is extracted again the next time it is fetched.
 */
function metaFromSources(snapshot: Snapshot, customIds: readonly string[]): ExtractionRequestMeta[] {
  if (customIds.length === 0) return [];
  const rows = snapshot.all(
    `SELECT id, url, kind FROM sources WHERE id IN ${inList(customIds)}`,
    z.object({ id: z.string(), url: z.string(), kind: sourceKindSchema }),
  );
  return rows
    .filter((r) => /^[a-zA-Z0-9_-]{1,64}$/.test(r.id))
    .map((r) => ({
      custom_id: r.id,
      page_url: r.url,
      kind: r.kind,
      hash: UNKNOWN_HASH,
      jsonld_events: [],
      directory_host: r.kind === "directory" ? hostOf(r.url) : null,
    }));
}

function mergeResult(into: StageResult, add: StageResult): void {
  for (const [k, v] of Object.entries(add.counters)) {
    const key = k as keyof StageResult["counters"];
    into.counters[key] = (into.counters[key] ?? 0) + (v ?? 0);
  }
  into.budgetHits.push(...add.budgetHits);
  into.errors.push(...add.errors);
  into.holds.push(...add.holds);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Per-run data that PipelineState has no field for. */
interface WireState {
  /** Pages whose results came from an earlier run's batch (hash unknown). */
  pendingOnly: Set<string>;
  /** Collected pages by URL (dedupe writes their hash and extracted_json). */
  collected: Map<string, ExtractedPage>;
}

export function wiredHandlers(edges: RunEdges): StageHandlers {
  const wire: WireState = { pendingOnly: new Set(), collected: new Map() };
  const withSide =
    (h: (env: StageEnv) => Promise<HandlerOutcome>) =>
    async (env: StageEnv): Promise<HandlerOutcome> => {
      fetchSide(env.state).ports ??= await edges.fetchSide();
      return h(env);
    };

  return {
    discover: withSide(discoverHandler),
    fetch: withSide(fetchHandler),
    normalize: withSide(normalizeHandler),

    "extract-request-build": async ({ ctx, guard, state, snapshot }) => {
      // Unchanged hash: no extraction (the hash in `sources` is the last *collected* one).
      const pages = state.normalized.filter((p) => !p.unchanged);
      const source_ids: Record<string, string> = {};
      for (const r of snapshot.all(
        `SELECT id, url FROM sources WHERE url IN ${inList(pages.map((p) => p.url))}`,
        idUrl,
      )) {
        if (/^[a-zA-Z0-9_-]{1,64}$/.test(r.id)) source_ids[r.url] = r.id;
      }
      const out = extractRequestBuild(ctx, { pages, allowance: guard.allowance(), source_ids });
      state.extractionRequests = out.output.requests;
      state.extractionMeta = out.output.meta;
      ctx.log.info("extract-request-build", {
        requests: out.output.requests.length,
        deferred: out.output.deferred.length,
        est_input_tokens: out.output.requests.reduce((n, r) => n + r.est_input_tokens, 0),
      });
      return { result: out.result };
    },

    "extract-collect": async ({ ctx, guard, state, snapshot, runId }) => {
      const result = emptyResult();
      const cli = edges.claudeCli();
      const pendingFromDb = pendingNightlyBatch(snapshot, runId);
      // claude-cli answers every request before submit returns: no batch is ever
      // pending, and a Message Batches id left by an API run is not its to collect.
      const pending = cli ? null : pendingFromDb;
      if (cli && pendingFromDb)
        ctx.log.warn("a Message Batches batch is pending from an earlier API run; claude-cli leaves it", {
          batch_id: pendingFromDb,
        });
      if (pending) ctx.log.info("collecting the batch the last nightly run left pending", { batch_id: pending });
      const before = cli?.stats() ?? null;
      // The guard is charged the estimate before submit; the client also stops on actual usage.
      cli?.setInputTokenLimit(guard.remaining("MAX_LLM_INPUT_TOKENS_PER_RUN"));
      const outcome = await runExtractionBatch(edges.extractionBatch(), state.extractionRequests, {
        pendingBatchId: pending,
        budget: guard,
        sleep: edges.poll.sleep,
        nowMs: edges.poll.nowMs,
        pollIntervalMs: edges.poll.intervalMs,
        maxWaitMs: edges.poll.maxWaitMs,
      });
      if (cli && before) {
        const after = cli.stats();
        const actual = after.input_tokens - before.input_tokens;
        const estimated = outcome.submitted > 0 ? state.extractionRequests.reduce((n, r) => n + r.est_input_tokens, 0) : 0;
        // Claude Code adds its own overhead to every request: meter what was really used.
        if (actual > estimated) guard.record({ llm_input_tokens: actual - estimated });
        if (after.token_capped > before.token_capped)
          guard.recordHit(
            "MAX_LLM_INPUT_TOKENS_PER_RUN",
            "extract-collect",
            `${after.token_capped - before.token_capped} requests not sent (actual claude -p usage)`,
          );
        ctx.log.info("claude-cli extraction", {
          requests: after.requests - before.requests,
          succeeded: after.succeeded - before.succeeded,
          errored: after.errored - before.errored,
          input_tokens: actual,
          estimated_input_tokens: estimated,
          output_tokens: after.output_tokens - before.output_tokens,
          cost_usd_at_api_prices: Math.round((after.cost_usd - before.cost_usd) * 100) / 100,
        });
      }
      if (outcome.status === "pending") {
        ctx.log.info("batch still running after the wait; the next nightly run collects it", {
          batch_id: outcome.batchId,
        });
      }

      // This run's results first, so a page in both batches keeps this run's meta.
      const ours = new Set(state.extractionMeta.map((m) => m.custom_id));
      const results: BatchResult[] = [
        ...outcome.results.filter((r) => ours.has(r.custom_id)),
        ...outcome.results.filter((r) => !ours.has(r.custom_id)),
      ];
      const earlier = metaFromSources(
        snapshot,
        [...new Set(results.map((r) => r.custom_id).filter((id) => !ours.has(id)))],
      );
      for (const m of earlier) wire.pendingOnly.add(m.page_url);
      const out = extractCollect(ctx, { results, meta: [...state.extractionMeta, ...earlier] });
      mergeResult(result, out.result);
      guard.recordOutputTokens(out.output.usage.output_tokens);
      state.extracted = out.output.pages;
      for (const p of out.output.pages) wire.collected.set(p.url, p);
      return {
        result,
        pendingBatchId: outcome.status === "pending" ? outcome.batchId : null,
      };
    },

    classify: async ({ ctx, guard, state }) => {
      const { lookup, error } = await edges.irs(guard);
      const out = classify(ctx, { events: state.extracted.flatMap((p) => p.events), irs: lookup });
      state.classified = out.output.outings;
      if (error) out.result.errors.push({ stage: "classify", kind: "network", message: error });
      return { result: out.result };
    },

    match: async ({ ctx, state, snapshot }) => {
      const states = new Set(
        state.classified.map((o) => o.venue_state).filter((s): s is string => s !== null),
      );
      const courses = snapshot.all(`SELECT * FROM courses WHERE state IN ${inList(states)}`, courseRowSchema);
      const places = snapshot.all(
        `SELECT name, state, lat, lng FROM cities WHERE state IN ${inList(states)}`,
        placeCitySchema,
      );
      const out = match(ctx, { outings: state.classified, courses, places });
      state.matched = out.output.outings;
      return { result: out.result };
    },

    "dedupe-upsert": async ({ ctx, state, snapshot }) => {
      const courseIds = state.matched.flatMap((o) => (o.match.kind === "matched" ? [o.match.course_id] : []));
      const fetchedPages = state.fetched;
      const urls = new Set([
        ...fetchedPages.map((f) => f.url),
        ...state.matched.map((o) => o.source_url),
        ...wire.pendingOnly,
      ]);
      const existing: DedupeUpsertInput["existing"] = {
        outings: snapshot.all(`SELECT * FROM outings WHERE course_id IN ${inList(courseIds)}`, outingRowSchema),
        organizers: snapshot.all("SELECT id, slug, name, ein, charity_status FROM organizers", organizerRow),
        sources: snapshot.all(`SELECT * FROM sources WHERE url IN ${inList(urls)}`, sourceRowSchema),
        outingSlugs: snapshot.all("SELECT slug FROM outings", slugRow).map((r) => r.slug),
        organizerSlugs: snapshot.all("SELECT slug FROM organizers", slugRow).map((r) => r.slug),
      };
      // The content hash is written only for pages whose extraction was collected
      // in this run; a page still waiting (or deferred by a cap) is extracted
      // again the next time it is fetched.
      const fetches: DedupeUpsertInput["fetches"] = [];
      const seen = new Set<string>();
      for (const f of fetchedPages) {
        if (seen.has(f.url)) continue;
        seen.add(f.url);
        const got = wire.pendingOnly.has(f.url) ? undefined : wire.collected.get(f.url);
        fetches.push({
          url: f.url,
          kind: f.kind,
          http_status: f.http_status,
          outcome: f.outcome,
          hash: got?.hash ?? null,
          extracted_json: got?.extracted_json ?? null,
          error: f.error,
        });
      }
      const unchanged = state.normalized
        .filter((p) => p.unchanged)
        .map((p) => ({ url: p.url, recheck_outing_id: p.recheck_outing_id }));
      const out = dedupeUpsert(ctx, { outings: state.matched, existing, unchanged, fetches });
      state.upsertOutcomes = out.output.outcomes;

      // Results from an earlier run's batch: keep the model's answer on the source row.
      const ops: TableOp[] = [...out.output.plan.ops];
      for (const url of wire.pendingOnly) {
        const page = wire.collected.get(url);
        if (!page) continue;
        ops.push({
          op: "update",
          table: "sources",
          set: { extracted_json: page.extracted_json, extractor_version: EXTRACTOR_VERSION },
          where: { url },
        });
      }
      return { result: out.result, plan: { ops } };
    },

    publish: async ({ ctx, state, snapshot, mode }) => {
      const changed = state.upsertOutcomes
        .filter((o) => o.outing_id !== null && o.action !== "held" && o.action !== "excluded")
        .map((o) => o.outing_id as string);
      const out = publish(ctx, {
        outings: outingsWithContext(snapshot),
        heldSources: snapshot.all("SELECT * FROM sources WHERE hold_reason IS NOT NULL", sourceRowSchema),
        changed: [...new Set(changed)],
        platform_rules: platformRulesFrom(await loadPlatforms(PATHS.overrides)),
      });
      state.publishDecisions = out.output.decisions;
      state.indexnowUrls = out.output.indexnowUrls;
      const result = out.result;
      const client = edges.indexnow();
      if (out.output.indexnowUrls.length > 0) {
        if (client) {
          try {
            await client.ping(out.output.indexnowUrls);
          } catch (err) {
            result.errors.push({
              stage: "publish",
              kind: "network",
              message: `IndexNow: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        } else {
          ctx.log.info(
            mode === "dry-run" ? "IndexNow ping skipped (dry run)" : "IndexNow ping skipped (INDEXNOW_KEY not set)",
            { urls: out.output.indexnowUrls.length },
          );
        }
      }
      return { result, plan: out.output.plan };
    },

    "recheck-roll-forward": async ({ ctx, snapshot }) => {
      const out = recheckRollForward(ctx, {
        outings: outingsWithContext(snapshot),
        sources: snapshot.all(
          "SELECT * FROM sources WHERE id IN (SELECT source_id FROM source_outings)",
          sourceRowSchema,
        ),
        outingSlugs: snapshot.all("SELECT slug FROM outings", slugRow).map((r) => r.slug),
      });
      return { result: out.result, plan: out.output.plan };
    },

    // Workstream D's monthly edges; a live run hands them the shared batch client
    // and B's fetcher through env.ports.
    courses: coursesHandler(),
    irs: irsHandler(),
    "course-types": courseTypesHandler(),
  };
}
