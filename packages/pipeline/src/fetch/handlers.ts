import { z } from "zod";
import type { HandlerOutcome, StageEnv } from "../run/handlers.ts";
import type { PipelineState } from "../run/state.ts";
import { runSerpQueries } from "../serp/fixture.ts";
import { sqlValue } from "../sql/literal.ts";
import { discover, planSearch } from "../stages/discover.ts";
import { planFetch, queueBookkeeping } from "../stages/fetch-plan.ts";
import { normalize } from "../stages/normalize.ts";
import { sourceKindSchema, type DiscoveryQueueRow } from "../stages/rows.ts";
import {
  COUNTS_AS_FETCH_ERROR,
  recheckCandidateSchema,
  type Counters,
  type FetchedPage,
  type FetchPlanItem,
  type QueueEntry,
  type RecheckCandidate,
  type TableOp,
} from "../stages/types.ts";
import { fetchAll } from "./fetcher.ts";
import { createFetchSidePorts, type FetchSidePorts } from "./ports.ts";

/**
 * Stage handlers for discover, fetch and normalize (workstream B): read the
 * snapshot, call the fetch-side edges with the BudgetGuard, run the pure
 * stages, and hand the outputs along PipelineState. Data that PipelineState has
 * no field for (pending queue rows, failed fetches) rides in `fetchSide(state)`
 * so workstream E can pass it to dedupe-upsert.
 */

export interface FetchSideState {
  ports: FetchSidePorts | null;
  pending: DiscoveryQueueRow[];
  /** Fetches that produced no normalized page (errors, 404/410, robots, unsupported). */
  failed: FetchedPage[];
}

const sideStates = new WeakMap<PipelineState, FetchSideState>();

export function fetchSide(state: PipelineState): FetchSideState {
  let s = sideStates.get(state);
  if (!s) {
    s = { ports: null, pending: [], failed: [] };
    sideStates.set(state, s);
  }
  return s;
}

async function portsFor(env: StageEnv): Promise<FetchSidePorts> {
  const side = fetchSide(env.state);
  side.ports ??= await createFetchSidePorts(env.ctx, env.mode);
  return side.ports;
}

const DAY_MS = 86_400_000;

function isoMinus(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

/** Rows that fail validation are dropped with a warning instead of failing the stage. */
function valid<T>(env: StageEnv, what: string, rows: unknown[], schema: z.ZodType<T, z.ZodTypeDef, unknown>): T[] {
  const out: T[] = [];
  let bad = 0;
  for (const r of rows) {
    const p = schema.safeParse(r);
    if (p.success) out.push(p.data);
    else bad++;
  }
  if (bad > 0) env.ctx.log.warn(`discover: skipped ${bad} invalid ${what} rows`);
  return out;
}

const looseRow = z.record(z.unknown());

/** Normalizes SQLite timestamps (`2026-09-20 10:00:00`, no zone) to ISO UTC. */
function isoTs(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]00:?00)?$/.exec(v);
  return m ? `${m[1]}T${m[2]}${m[3] ?? ""}Z` : v;
}

export async function discoverHandler(env: StageEnv): Promise<HandlerOutcome> {
  const { ctx, guard, state, snapshot } = env;
  const ports = await portsFor(env);
  const now = ctx.now;
  const today = now.toISOString().slice(0, 10);

  const recheckRows = snapshot.all(
    "SELECT o.id AS outing_id, o.canonical_source_url AS url, o.status, o.start_date, o.last_verified, " +
      "c.time_zone, s.kind AS source_kind FROM outings o JOIN courses c ON c.id = o.course_id " +
      "LEFT JOIN sources s ON s.url = o.canonical_source_url " +
      "WHERE o.published = 1 AND o.status IN ('open', 'waitlist') AND o.start_date IS NOT NULL",
    looseRow,
  );
  const recheck: RecheckCandidate[] = valid(
    env,
    "recheck",
    recheckRows.map((r) => ({
      ...r,
      last_verified: isoTs(r.last_verified),
      source_kind: r.source_kind ?? undefined,
    })),
    recheckCandidateSchema,
  );
  const submissions = valid(
    env,
    "submission",
    snapshot
      .all("SELECT id, url, created_at FROM submissions WHERE processed = 0", looseRow)
      .map((r) => ({ ...r, created_at: isoTs(r.created_at) })),
    z.object({ id: z.string(), url: z.string(), created_at: z.string() }),
  ).map((s) => ({ ...s, created_at: s.created_at }));
  const recentlyFetched = valid(
    env,
    "recent source",
    snapshot
      .all(
        `SELECT url, fetched_at FROM sources WHERE fetched_at IS NOT NULL AND fetched_at >= ${sqlValue(isoMinus(now, 8 * DAY_MS))}`,
        looseRow,
      )
      .map((r) => ({ ...r, fetched_at: isoTs(r.fetched_at) })),
    z.object({ url: z.string().url(), fetched_at: z.string() }),
  );
  const heldSources = valid(
    env,
    "held source",
    snapshot.all(
      `SELECT url, held_until, kind FROM sources WHERE hold_reason IS NOT NULL AND held_until IS NOT NULL AND held_until >= ${sqlValue(today)}`,
      looseRow,
    ),
    z.object({
      url: z.string().url(),
      held_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      kind: sourceKindSchema.optional(),
    }),
  );
  const pending = valid(
    env,
    "discovery_queue",
    snapshot
      .all("SELECT url, found_via, found_at, priority, next_attempt_at, attempts FROM discovery_queue", looseRow)
      .map((r) => ({ ...r, found_at: isoTs(r.found_at), next_attempt_at: isoTs(r.next_attempt_at) })),
    z.object({
      url: z.string(),
      found_via: z.string(),
      found_at: z.string(),
      priority: z.number().int(),
      next_attempt_at: z.string().nullable(),
      attempts: z.number().int().min(0),
    }),
  );
  fetchSide(state).pending = pending;
  const courses = valid(
    env,
    "course",
    snapshot.all("SELECT id, name, outing_count, notable FROM courses WHERE outing_count > 0 OR notable = 1", looseRow),
    z.object({
      id: z.string(),
      name: z.string(),
      outing_count: z.number().int(),
      notable: z.union([z.boolean(), z.number()]).transform((v) => v === true || v === 1),
    }),
  );

  // Search: plan tonight's queries, then run them through the adapter and the guard.
  const search = planSearch(ctx, {
    metros: ctx.overrides.metros.map((m) => ({ name: m.name, state: m.state, population: m.population })),
    courses,
    allowance: guard.allowance(),
  });
  state.serpQueries = search.output.queries;
  const serp = env.ports.serp ?? ports.serp;
  const serpResults = await runSerpQueries(serp, search.output.queries, guard);

  // Listing sources fetch through the guarded fetcher; the fetch timer starts here.
  guard.startFetchTimer();
  const listings = await (env.ports.listings ?? ports.listings).links(guard);

  const out = discover(ctx, {
    recheck,
    submissions,
    listings,
    serpResults,
    recentlyFetched,
    heldSources,
    pending,
    allowance: guard.allowance(),
  });
  state.queue = out.output.queue;
  state.processedSubmissionIds = out.output.processedSubmissionIds;

  const ops: TableOp[] = out.output.processedSubmissionIds.map((id) => ({
    op: "update",
    table: "submissions",
    set: { processed: 1 },
    where: { id },
  }));
  const counters: Counters = { ...out.result.counters };
  ctx.log.info("discover", {
    serp_queries: search.output.queries.length,
    serp_results: serpResults.length,
    listing_links: listings.length,
    recheck_candidates: recheck.length,
    queued: out.output.queue.length,
    skipped: out.output.skipped.length,
  });
  return {
    result: {
      ...out.result,
      counters,
      budgetHits: [...search.result.budgetHits, ...out.result.budgetHits],
    },
    plan: { ops },
  };
}

function toQueueEntry(i: FetchPlanItem): QueueEntry {
  const { host: _h, render: _r, ...q } = i;
  return q;
}

function fetchCounters(pages: readonly FetchedPage[]): Counters {
  const c: Counters = {};
  for (const p of pages) {
    if (COUNTS_AS_FETCH_ERROR.has(p.outcome)) c.fetch_errors = (c.fetch_errors ?? 0) + 1;
    if (p.outcome === "not_found" || p.outcome === "gone") c.fetch_not_found = (c.fetch_not_found ?? 0) + 1;
    if (p.outcome === "robots_blocked") c.robots_blocked = (c.robots_blocked ?? 0) + 1;
  }
  return c;
}

export async function fetchHandler(env: StageEnv): Promise<HandlerOutcome> {
  const { ctx, guard, state } = env;
  const ports = await portsFor(env);
  guard.startFetchTimer();
  const plan = planFetch(ctx, { queue: state.queue, allowance: guard.allowance() });
  state.fetchPlan = plan.output.items;
  const fetched = await fetchAll(plan.output.items, env.ports.fetcher ?? ports.fetcher, guard);
  state.fetched = fetched.pages;
  const deferred = [...plan.output.deferred, ...fetched.deferred.map(toQueueEntry)];
  const bookkeeping = queueBookkeeping(ctx.now, {
    deferred,
    fetched: fetched.pages,
    pending: fetchSide(state).pending,
  });
  ctx.log.info("fetch", {
    planned: plan.output.items.length,
    fetched: fetched.pages.length,
    deferred: deferred.length,
  });
  return {
    result: { ...plan.result, counters: { ...plan.result.counters, ...fetchCounters(fetched.pages) } },
    plan: bookkeeping,
  };
}

export async function normalizeHandler(env: StageEnv): Promise<HandlerOutcome> {
  const { ctx, guard, state, snapshot } = env;
  const ports = await portsFor(env);
  const previousHashes: Record<string, string> = {};
  for (const r of snapshot.all(
    "SELECT url, content_hash FROM sources WHERE content_hash IS NOT NULL",
    z.object({ url: z.string(), content_hash: z.string() }),
  )) {
    if (/^[0-9a-f]{64}$/.test(r.content_hash)) previousHashes[r.url] = r.content_hash;
  }

  const first = normalize(ctx, { pages: state.fetched, previousHashes });
  let pages = first.output.pages;
  const failed = [...first.output.failed];
  const counters: Counters = { ...first.result.counters };

  // SPEC.md 8.3: main text under 400 characters from a plain fetch gets one headless render.
  const toRender = pages.filter((p) => p.needs_render);
  if (toRender.length > 0 && ports.renderer) {
    const byUrl = new Map(state.fetchPlan.map((i) => [i.url, i] as const));
    const rendered: FetchedPage[] = [];
    for (const p of toRender) {
      if (guard.remaining("MAX_RENDERS_PER_RUN") <= 0) break;
      const fetchedPage = state.fetched.find((f) => f.url === p.url);
      const item = byUrl.get(fetchedPage?.requested_url ?? p.url);
      if (!item) continue;
      try {
        rendered.push(await (env.ports.fetcher ?? ports.fetcher).fetchPage({ ...item, render: true }, guard));
      } catch {
        break; // fetch budget used up: keep the plain text
      }
    }
    const again = normalize(ctx, { pages: rendered.filter((r) => r.rendered), previousHashes });
    const replaced = new Map(again.output.pages.map((p) => [p.url, p] as const));
    pages = pages.map((p) => replaced.get(p.url) ?? p);
    for (const [k, v] of Object.entries(again.result.counters)) {
      counters[k as keyof Counters] = (counters[k as keyof Counters] ?? 0) + v;
    }
    state.fetched = state.fetched.map((f) => rendered.find((r) => r.requested_url === f.requested_url) ?? f);
  }
  state.normalized = pages;
  fetchSide(state).failed = failed;
  // The renderer stays open: the run closes the fetch-side edges when it ends.
  ctx.log.info("normalize", {
    pages: pages.length,
    unchanged: counters.pages_unchanged ?? 0,
    rendered: pages.filter((p) => p.rendered).length,
    failed: failed.length,
  });
  return { result: { ...first.result, counters } };
}
