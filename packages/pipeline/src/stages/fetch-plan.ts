import { hostOf } from "../discovery/url.ts";
import { hostMatches } from "../overrides/load.ts";
import type { DiscoveryQueueRow } from "./rows.ts";
import {
  COUNTS_AS_FETCH_ERROR,
  emptyResult,
  type BudgetHit,
  type FetchedPage,
  type FetchPlanItem,
  type FetchPlanStage,
  type QueueEntry,
  type TableOp,
  type UpsertPlan,
} from "./types.ts";

/**
 * SPEC.md 8.3, workstream B. Orders the queue into fetch items within
 * MAX_FETCHES_PER_RUN, MAX_RENDERS_PER_RUN and MAX_FETCHES_PER_HOST_PER_RUN, and
 * marks `render` for hosts in js-platforms.yaml. Rechecks take at most 40% of
 * MAX_FETCHES_PER_RUN. Everything over a cap is `deferred` and stays in
 * `discovery_queue` for a later run. The fetcher edge (PageFetcher) does the
 * I/O and enforces MAX_FETCH_MINUTES.
 */

const STAGE = "fetch";
export const RECHECK_SHARE = 0.4;

export const planFetch: FetchPlanStage = (ctx, input) => {
  const result = emptyResult();
  const caps = ctx.caps;
  const maxFetches = input.allowance.MAX_FETCHES_PER_RUN ?? caps.MAX_FETCHES_PER_RUN;
  const maxRenders = input.allowance.MAX_RENDERS_PER_RUN ?? caps.MAX_RENDERS_PER_RUN;
  const perHost = input.allowance.MAX_FETCHES_PER_HOST_PER_RUN ?? caps.MAX_FETCHES_PER_HOST_PER_RUN;
  const maxRechecks = Math.floor(RECHECK_SHARE * caps.MAX_FETCHES_PER_RUN);

  const hits = new Map<BudgetHit["cap"], BudgetHit>();
  const hitOnce = (cap: BudgetHit["cap"], limit: number, detail: string) => {
    if (!hits.has(cap)) {
      hits.set(cap, { stage: STAGE, cap, limit, at: ctx.now.toISOString(), detail });
    }
  };

  const ordered = input.queue
    .map((q, i) => ({ q, i }))
    .sort((a, b) => a.q.priority - b.q.priority || a.i - b.i)
    .map((x) => x.q);

  const items: FetchPlanItem[] = [];
  const deferred: QueueEntry[] = [];
  const hostCount = new Map<string, number>();
  let rechecks = 0;
  let renders = 0;

  for (const q of ordered) {
    const host = hostOf(q.url);
    if (host === null) continue;
    if (items.length >= maxFetches) {
      hitOnce("MAX_FETCHES_PER_RUN", maxFetches, "queue longer than the fetch cap");
      deferred.push(q);
      continue;
    }
    if (q.found_via === "recheck" && rechecks >= maxRechecks) {
      hitOnce("MAX_FETCHES_PER_RUN", maxFetches, `recheck share (${RECHECK_SHARE * 100}%) reached`);
      deferred.push(q);
      continue;
    }
    const n = hostCount.get(host) ?? 0;
    if (n >= perHost) {
      hitOnce("MAX_FETCHES_PER_HOST_PER_RUN", perHost, host);
      deferred.push(q);
      continue;
    }
    const render = hostMatches(host, ctx.overrides.jsPlatforms);
    if (render && renders >= maxRenders) {
      // A JS platform without a render yields an empty shell; wait for a run with renders left.
      hitOnce("MAX_RENDERS_PER_RUN", maxRenders, host);
      deferred.push(q);
      continue;
    }
    if (render) renders++;
    if (q.found_via === "recheck") rechecks++;
    hostCount.set(host, n + 1);
    items.push({ ...q, host, render });
  }

  result.budgetHits.push(...hits.values());
  return { output: { items, deferred }, result };
};

// ---------------------------------------------------------------------------
// discovery_queue bookkeeping (applied by the fetch handler)
// ---------------------------------------------------------------------------

/** A URL whose fetch failed transiently is retried this many times, a day apart. */
export const MAX_QUEUE_ATTEMPTS = 3;
const RETRY_AFTER_MS = 86_400_000;

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

/**
 * What the fetch stage writes to `discovery_queue`: deferred entries are
 * stored (or keep their row), fetched URLs leave the queue, and network, timeout
 * and 5xx failures come back the next day, up to three attempts.
 */
export function queueBookkeeping(
  now: Date,
  input: {
    deferred: readonly QueueEntry[];
    fetched: readonly FetchedPage[];
    pending: readonly DiscoveryQueueRow[];
  },
): UpsertPlan {
  const ops: TableOp[] = [];
  const pending = new Map(input.pending.map((p) => [p.url, p] as const));
  const nowIso = iso(now);

  const keep = input.deferred.map((q) => ({
    url: q.url,
    found_via: q.found_via,
    found_at: pending.get(q.url)?.found_at ?? nowIso,
    priority: q.priority,
    next_attempt_at: null,
    attempts: pending.get(q.url)?.attempts ?? 0,
  }));
  if (keep.length > 0) {
    ops.push({ op: "upsert", table: "discovery_queue", rows: keep, update: ["priority"] });
  }

  const retry: DiscoveryQueueRow[] = [];
  for (const p of input.fetched) {
    const url = p.requested_url;
    const prev = pending.get(url);
    const attempts = (prev?.attempts ?? 0) + 1;
    if (COUNTS_AS_FETCH_ERROR.has(p.outcome) && attempts < MAX_QUEUE_ATTEMPTS) {
      retry.push({
        url,
        found_via: p.found_via,
        found_at: prev?.found_at ?? nowIso,
        priority: prev?.priority ?? 5,
        next_attempt_at: iso(new Date(now.getTime() + RETRY_AFTER_MS)),
        attempts,
      });
    } else if (prev) {
      ops.push({ op: "delete", table: "discovery_queue", where: { url } });
    }
  }
  if (retry.length > 0) {
    ops.push({
      op: "upsert",
      table: "discovery_queue",
      rows: retry,
      update: ["next_attempt_at", "attempts"],
    });
  }
  return { ops };
}
