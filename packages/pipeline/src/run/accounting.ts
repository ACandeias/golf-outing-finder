import { randomBytes } from "node:crypto";
import { ulid } from "@gof/shared/ids";
import type { BudgetGuard } from "../budget.ts";
import { runRowSchema, type RunRow } from "../stages/rows.ts";
import {
  RUN_COUNTERS,
  type BudgetHit,
  type Counters,
  type StageError,
  type UpsertPlan,
} from "../stages/types.ts";

/**
 * The `runs` row (SPEC.md 7.1, 8.0, 8.10): written when the run starts and
 * updated after every stage, so a killed job still leaves a record.
 *
 * Metered columns (serp_queries, fetches, renders, extractions,
 * course_classifications, llm_input_tokens, llm_output_tokens) come from the
 * BudgetGuard, the single meter. outings_new, outings_updated and outings_held
 * are summed from stage counters.
 */

export const MAX_STORED_ERRORS = 200;

export function newRunId(nowMs: number, random: Uint8Array = randomBytes(10)): string {
  return `run_${ulid(nowMs, random)}`;
}

export function newRunRow(id: string, kind: RunRow["kind"], startedAt: Date): RunRow {
  return runRowSchema.parse({
    id,
    kind,
    started_at: startedAt.toISOString(),
    finished_at: null,
    stages_done: "[]",
    serp_queries: 0,
    fetches: 0,
    renders: 0,
    extractions: 0,
    course_classifications: 0,
    llm_input_tokens: 0,
    llm_output_tokens: 0,
    pending_batch_id: null,
    outings_new: 0,
    outings_updated: 0,
    outings_held: 0,
    budget_hits: "[]",
    errors: "[]",
    est_cost_cents: 0,
  });
}

function jsonList<T>(text: string): T[] {
  const v: unknown = JSON.parse(text);
  return Array.isArray(v) ? (v as T[]) : [];
}

export interface StageUpdate {
  stage: string;
  /** Add the stage to stages_done (it completed). */
  done: boolean;
  counters: Counters;
  errors: readonly StageError[];
  guard: BudgetGuard;
  /** Undefined leaves the column as it is; null clears it. */
  pendingBatchId?: string | null;
}

/** The row after a stage: pure. */
export function applyStageUpdate(row: RunRow, u: StageUpdate): RunRow {
  const stagesDone = jsonList<string>(row.stages_done);
  if (u.done && !stagesDone.includes(u.stage)) stagesDone.push(u.stage);
  const errors = [...jsonList<StageError>(row.errors), ...u.errors].slice(-MAX_STORED_ERRORS);
  const hits: BudgetHit[] = u.guard.hits();
  const next: RunRow = {
    ...row,
    stages_done: JSON.stringify(stagesDone),
    serp_queries: u.guard.spent("MAX_SERP_QUERIES_PER_RUN"),
    fetches: u.guard.spent("MAX_FETCHES_PER_RUN"),
    renders: u.guard.spent("MAX_RENDERS_PER_RUN"),
    extractions: u.guard.spent("MAX_EXTRACTIONS_PER_RUN"),
    course_classifications: u.guard.spent("MAX_COURSE_CLASSIFICATIONS_PER_RUN"),
    llm_input_tokens: u.guard.spent("MAX_LLM_INPUT_TOKENS_PER_RUN"),
    llm_output_tokens: u.guard.outputTokensSpent(),
    outings_new: row.outings_new + (u.counters.outings_new ?? 0),
    outings_updated: row.outings_updated + (u.counters.outings_updated ?? 0),
    outings_held: row.outings_held + (u.counters.outings_held ?? 0),
    budget_hits: JSON.stringify(hits),
    errors: JSON.stringify(errors),
    est_cost_cents: u.guard.estCostCents(),
    pending_batch_id: u.pendingBatchId === undefined ? row.pending_batch_id : u.pendingBatchId,
  };
  return runRowSchema.parse(next);
}

export function finishRunRow(row: RunRow, finishedAt: Date): RunRow {
  return runRowSchema.parse({ ...row, finished_at: finishedAt.toISOString() });
}

/** Upsert of the whole row by id. */
export function runRowPlan(row: RunRow): UpsertPlan {
  return { ops: [{ op: "upsert", table: "runs", rows: [row] }] };
}

/** Counters for the summary: the row's columns plus extra counters reported by stages. */
export function summaryCounters(row: RunRow, extra: Counters): Counters {
  const out: Counters = { ...extra };
  for (const c of RUN_COUNTERS) out[c] = row[c];
  return out;
}
