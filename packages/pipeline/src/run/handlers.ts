import type { BudgetGuard } from "../budget.ts";
import type { D1Port, Snapshot } from "../d1/port.ts";
import { classify } from "../stages/classify.ts";
import { courseTypesRequestBuild } from "../stages/course-types.ts";
import { courses } from "../stages/courses.ts";
import { dedupeUpsert } from "../stages/dedupe-upsert.ts";
import { discover, planSearch } from "../stages/discover.ts";
import { extractCollect } from "../stages/extract-collect.ts";
import { extractRequestBuild } from "../stages/extract-request-build.ts";
import { planFetch } from "../stages/fetch-plan.ts";
import { irs } from "../stages/irs.ts";
import { match } from "../stages/match.ts";
import { normalize } from "../stages/normalize.ts";
import { publish } from "../stages/publish.ts";
import { recheckRollForward } from "../stages/recheck-roll-forward.ts";
import type { StageName } from "../stages/registry.ts";
import type { Context, IrsLookup, Ports, StageResult, UpsertPlan } from "../stages/types.ts";
import type { PipelineState } from "./state.ts";

/** What a handler gets: the stage Context plus the edges it may use. */
export interface StageEnv {
  stage: StageName;
  mode: "dry-run" | "live";
  ctx: Context;
  guard: BudgetGuard;
  state: PipelineState;
  /** The run-start snapshot (read-only). */
  snapshot: Snapshot;
  d1: D1Port;
  /** Network edges; fixture-backed in a dry run (workstream E wires them). */
  ports: Partial<Ports>;
  irs: IrsLookup | null;
}

export interface HandlerOutcome {
  result: StageResult;
  /** Applied by the runner right after the stage. */
  plan?: UpsertPlan;
  /** Set to record or clear runs.pending_batch_id. */
  pendingBatchId?: string | null;
}

/**
 * A handler runs one stage: reads its inputs from the snapshot and state, calls
 * edges (consuming the BudgetGuard before each paid or capped call), calls the
 * pure stage function, and stores the output in state. Workstream E replaces
 * these defaults with the wired versions; they only show the data flow and
 * surface NotImplemented from the stubs.
 */
export type StageHandler = (env: StageEnv) => Promise<HandlerOutcome>;
export type StageHandlers = Record<Exclude<StageName, "report">, StageHandler>;

const noIrs: IrsLookup = { byEin: () => null, candidates: () => [] };

export const defaultHandlers: StageHandlers = {
  discover: async ({ ctx, guard, state }) => {
    const search = planSearch(ctx, {
      metros: [...ctx.overrides.metros],
      courses: [],
      allowance: guard.allowance(),
    });
    state.serpQueries = search.output.queries;
    const out = discover(ctx, {
      recheck: [],
      submissions: [],
      listings: [],
      serpResults: [],
      recentlyFetched: [],
      heldSources: [],
      allowance: guard.allowance(),
    });
    state.queue = out.output.queue;
    state.processedSubmissionIds = out.output.processedSubmissionIds;
    return { result: out.result };
  },
  fetch: async ({ ctx, guard, state }) => {
    const out = planFetch(ctx, { queue: state.queue, allowance: guard.allowance() });
    state.fetchPlan = out.output.items;
    return { result: out.result };
  },
  normalize: async ({ ctx, state }) => {
    const out = normalize(ctx, { pages: state.fetched, previousHashes: {} });
    state.normalized = out.output.pages;
    return { result: out.result };
  },
  "extract-request-build": async ({ ctx, guard, state }) => {
    const out = extractRequestBuild(ctx, {
      pages: state.normalized.filter((p) => !p.unchanged),
      allowance: guard.allowance(),
    });
    state.extractionRequests = out.output.requests;
    state.extractionMeta = out.output.meta;
    return { result: out.result };
  },
  "extract-collect": async ({ ctx, state }) => {
    const out = extractCollect(ctx, { results: [], meta: state.extractionMeta });
    state.extracted = out.output.pages;
    return { result: out.result, pendingBatchId: null };
  },
  classify: async ({ ctx, state, irs: lookup }) => {
    const out = classify(ctx, {
      events: state.extracted.flatMap((p) => p.events),
      irs: lookup ?? noIrs,
    });
    state.classified = out.output.outings;
    return { result: out.result };
  },
  match: async ({ ctx, state }) => {
    const out = match(ctx, { outings: state.classified, courses: [], places: [] });
    state.matched = out.output.outings;
    return { result: out.result };
  },
  "dedupe-upsert": async ({ ctx, state }) => {
    const out = dedupeUpsert(ctx, {
      outings: state.matched,
      existing: { outings: [], organizers: [], sources: [], outingSlugs: [], organizerSlugs: [] },
      unchanged: [],
      fetches: [],
    });
    state.upsertOutcomes = out.output.outcomes;
    return { result: out.result, plan: out.output.plan };
  },
  publish: async ({ ctx, state }) => {
    const out = publish(ctx, { outings: [], heldSources: [], changed: [] });
    state.publishDecisions = out.output.decisions;
    state.indexnowUrls = out.output.indexnowUrls;
    return { result: out.result, plan: out.output.plan };
  },
  "recheck-roll-forward": async ({ ctx }) => {
    const out = recheckRollForward(ctx, { outings: [], sources: [], outingSlugs: [] });
    return { result: out.result, plan: out.output.plan };
  },
  courses: async ({ ctx }) => {
    const out = courses(ctx, {
      features: [],
      existing: [],
      places: [],
      websiteTypes: {},
      timeZoneAt: () => "America/New_York",
    });
    return { result: out.result, plan: out.output.plan };
  },
  irs: async ({ ctx }) => {
    const out = irs(ctx, { rows: [] });
    return { result: out.result };
  },
  "course-types": async ({ ctx, guard }) => {
    const out = courseTypesRequestBuild(ctx, {
      courses: [],
      pages: [],
      allowance: guard.allowance(),
    });
    return { result: out.result };
  },
};
