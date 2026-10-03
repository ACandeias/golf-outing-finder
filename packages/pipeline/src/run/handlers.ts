import type { BudgetGuard } from "../budget.ts";
import type { D1Port, Snapshot } from "../d1/port.ts";
import { NotImplemented } from "../stages/not-implemented.ts";
import type { StageName } from "../stages/registry.ts";
import type { Context, IrsLookup, Ports, StageResult, UpsertPlan } from "../stages/types.ts";
import type { PipelineState } from "./state.ts";
import { wiredHandlers, type RunEdges } from "./wire.ts";

/** What a handler gets: the stage Context plus the edges it may use. */
export interface StageEnv {
  stage: StageName;
  mode: "dry-run" | "live";
  /** The current `runs` row id (workstream D: resume and pending batches). */
  runId: string;
  /**
   * Records a step inside a long stage (e.g. `courses:NY`) in `runs.stages_done`
   * and writes the row now, so a killed job can resume after the last step
   * (workstream D).
   */
  markProgress: (entry: string) => Promise<void>;
  ctx: Context;
  guard: BudgetGuard;
  state: PipelineState;
  /** The run-start snapshot (read-only). */
  snapshot: Snapshot;
  d1: D1Port;
  /** Edges shared with workstream D's monthly handlers (live: the batch client and B's fetcher). */
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
 * pure stage function, and stores the output in state (src/run/wire.ts).
 */
export type StageHandler = (env: StageEnv) => Promise<HandlerOutcome>;
export type StageHandlers = Record<Exclude<StageName, "report">, StageHandler>;

/** Every stage with a handler (all but report, which the runner runs itself). */
export const HANDLED_STAGES: readonly Exclude<StageName, "report">[] = [
  "discover",
  "fetch",
  "normalize",
  "extract-request-build",
  "extract-collect",
  "classify",
  "match",
  "dedupe-upsert",
  "publish",
  "recheck-roll-forward",
  "courses",
  "irs",
  "course-types",
];

/**
 * The wired handlers (src/run/wire.ts) over edges built for this run. The CLI
 * calls this once per run and closes the edges when the run ends.
 */
export function defaultHandlers(edges: RunEdges): StageHandlers {
  return wiredHandlers(edges);
}

/** Handlers that all throw NotImplemented, for runner tests independent of the real edges. */
export function stubHandlers(): StageHandlers {
  const out = {} as StageHandlers;
  for (const name of HANDLED_STAGES) {
    out[name] = async () => {
      throw new NotImplemented(name);
    };
  }
  return out;
}
