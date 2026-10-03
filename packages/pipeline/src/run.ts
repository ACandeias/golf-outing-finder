import type { BudgetProfile } from "@gof/shared/budget";
import type { BudgetGuard, Meter } from "./budget.ts";

export type PipelineMode = "dry-run" | "live";

export interface RunOptions {
  mode: PipelineMode;
  budget: BudgetProfile;
  stages: string[] | null;
  guard: BudgetGuard;
}

export interface RunResult {
  budgetHits: Meter[];
  counts: Record<string, number>;
}

const ALL_STAGES = [
  "discover",
  "fetch",
  "extract",
  "classify",
  "match",
  "upsert",
  "publish",
  "recheck",
  "report",
] as const;

export async function runPipeline(opts: RunOptions): Promise<RunResult> {
  const stages = opts.stages ?? [...ALL_STAGES];
  const counts: Record<string, number> = {};
  for (const stage of stages) {
    counts[stage] = 0;
  }
  return { budgetHits: opts.guard.hitList(), counts };
}
