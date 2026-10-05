import { z } from "zod";
import { BudgetGuard } from "../budget.ts";
import type { D1Port } from "../d1/port.ts";
import { sqlValue } from "../sql/literal.ts";
import { isNotImplementedError } from "../stages/not-implemented.ts";
import { STAGES, type StageName } from "../stages/registry.ts";
import { report } from "../stages/report.ts";
import type { RunRow } from "../stages/rows.ts";
import {
  holdReasonSchema,
  stageResultSchema,
  type Context,
  type Counter,
  type HoldCounts,
  type IrsLookup,
  type Ports,
  type ReportOutput,
  type StageError,
  type StageStatus,
} from "../stages/types.ts";
import {
  applyStageUpdate,
  finishRunRow,
  newRunRow,
  runRowPlan,
  summaryCounters,
} from "./accounting.ts";
import type { StageHandlers } from "./handlers.ts";
import { emptyState, type PipelineState } from "./state.ts";

export type PipelineMode = "dry-run" | "live";
export type JobKind = "nightly" | "monthly";

export interface RunOptions {
  mode: PipelineMode;
  job: JobKind;
  /** In run order; `report` is always last (registry.selectStages). */
  stages: readonly StageName[];
  /** `--fail-stage`: throw inside this stage (Phase 5 alert test). */
  failStage: StageName | null;
  /** Unimplemented stages fail the run (workstream E turns this on). */
  strict: boolean;
  /** The report's cost line for subscription-backed providers, given the run's API-rate estimate. */
  costNote?: (estCostCents: number) => string | null;
}

export interface RunDeps {
  ctx: Context;
  d1: D1Port;
  handlers: StageHandlers;
  runId: string;
  ports?: Partial<Ports>;
  irs?: IrsLookup | null;
  writeSummary?: (markdown: string) => Promise<unknown>;
}

export interface RunOutcome {
  run: RunRow;
  statuses: StageStatus[];
  report: ReportOutput;
  state: PipelineState;
  budgetHits: ReturnType<BudgetGuard["hits"]>;
  exitCode: 0 | 1;
}

export class ForcedStageFailure extends Error {
  constructor(stage: string) {
    super(`forced failure (--fail-stage=${stage})`);
    this.name = "ForcedStageFailure";
  }
}

const runSpendSchema = z.object({
  id: z.string(),
  started_at: z.string(),
  est_cost_cents: z.number().int(),
});
const holdRowSchema = z.object({
  scope: z.enum(["sources", "outings"]),
  reason: holdReasonSchema,
  n: z.number().int(),
});

/** Holds by reason across `sources` and `outings` (SPEC.md 8.10). */
export const HOLD_COUNTS_SQL =
  "SELECT 'sources' AS scope, hold_reason AS reason, count(*) AS n FROM sources WHERE hold_reason IS NOT NULL GROUP BY hold_reason " +
  "UNION ALL SELECT 'outings' AS scope, hold_reason AS reason, count(*) AS n FROM outings WHERE hold_reason IS NOT NULL GROUP BY hold_reason";

async function holdCounts(d1: D1Port): Promise<{ sources: HoldCounts; outings: HoldCounts }> {
  const out = { sources: {} as HoldCounts, outings: {} as HoldCounts };
  for (const r of await d1.query(HOLD_COUNTS_SQL, holdRowSchema)) out[r.scope][r.reason] = r.n;
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function addCounters(into: PipelineState["counters"], add: PipelineState["counters"]): void {
  for (const [k, v] of Object.entries(add) as [Counter, number][]) into[k] = (into[k] ?? 0) + v;
}

/**
 * Runs the selected stages in order (SPEC.md 8.0). The `runs` row is written
 * before the first stage and after every stage. A budget hit stops only the
 * stage that hit it. A stage that throws fails the run: later stages are
 * skipped, the report still runs, and the exit code is 1. A stub that throws
 * NotImplemented is reported by name and fails the run only with `strict`.
 */
export async function runPipeline(opts: RunOptions, deps: RunDeps): Promise<RunOutcome> {
  const { ctx, d1 } = deps;
  const log = ctx.log;
  const startMs = ctx.clock.nowMs();
  const at = (): Date => new Date(ctx.now.getTime() + Math.max(0, ctx.clock.nowMs() - startMs));

  let row = newRunRow(deps.runId, opts.job, ctx.now);
  await d1.apply(runRowPlan(row));
  log.info("run started", { id: row.id, kind: row.kind, mode: opts.mode, stages: opts.stages });

  const snapshot = await d1.snapshot();
  try {
    const month = ctx.now.toISOString().slice(0, 7);
    const monthRuns = snapshot.all(
      `SELECT id, started_at, est_cost_cents FROM runs WHERE substr(started_at, 1, 7) = ${sqlValue(month)}`,
      runSpendSchema,
    );
    const guard = new BudgetGuard({
      caps: { ...ctx.caps },
      now: ctx.now,
      monthRuns,
      runId: row.id,
      clock: ctx.clock,
    });
    const state = emptyState();
    const statuses: StageStatus[] = [];
    let failed = false;

    for (const stage of opts.stages) {
      if (stage === "report") continue;
      const t0 = ctx.clock.nowMs();
      const ms = (): number => Math.max(0, Math.round(ctx.clock.nowMs() - t0));
      if (failed) {
        statuses.push({ stage, status: "skipped", ms: 0, message: "an earlier stage failed" });
        continue;
      }
      const errors: StageError[] = [];
      let counters: PipelineState["counters"] = {};
      let done = false;
      let pendingBatchId: string | null | undefined;
      try {
        if (STAGES[stage].paid) guard.monthlySpendOk(stage);
        if (opts.failStage === stage) throw new ForcedStageFailure(stage);
        const out = await deps.handlers[stage]({
          stage,
          mode: opts.mode,
          runId: row.id,
          markProgress: async (entry: string) => {
            row = applyStageUpdate(row, {
              stage: entry,
              done: true,
              counters: {},
              errors: [],
              guard,
            });
            await d1.apply(runRowPlan(row));
          },
          ctx,
          guard,
          state,
          snapshot,
          d1,
          ports: deps.ports ?? {},
          irs: deps.irs ?? null,
        });
        const result = stageResultSchema.parse(out.result);
        guard.addHits(result.budgetHits);
        counters = result.counters;
        errors.push(...result.errors);
        state.holds.push(...result.holds);
        addCounters(state.counters, result.counters);
        if (out.plan && out.plan.ops.length > 0) await d1.apply(out.plan);
        if (out.pendingBatchId !== undefined) {
          pendingBatchId = out.pendingBatchId;
          state.pendingBatchId = out.pendingBatchId;
        }
        done = true;
        statuses.push({ stage, status: "done", ms: ms() });
        log.info(`stage ${stage} done`, {
          counters: result.counters,
          errors: result.errors.length,
        });
      } catch (err) {
        if (isNotImplementedError(err)) {
          statuses.push({
            stage,
            status: "not_implemented",
            ms: ms(),
            message: `workstream ${STAGES[stage].owner}`,
          });
          errors.push({ stage, kind: "not_implemented", message: err.message });
          log.warn(`stage ${stage} is not implemented yet`);
          if (opts.strict) failed = true;
        } else {
          failed = true;
          const kind = err instanceof ForcedStageFailure ? "forced" : "internal";
          statuses.push({ stage, status: "failed", ms: ms(), message: message(err) });
          errors.push({ stage, kind, message: message(err) });
          log.error(`stage ${stage} failed`, { error: message(err) });
        }
      }
      row = applyStageUpdate(row, { stage, done, counters, errors, guard, pendingBatchId });
      await d1.apply(runRowPlan(row));
    }

    const t0 = ctx.clock.nowMs();
    const holds = await holdCounts(d1);
    row = finishRunRow(row, at());
    const rep = report(ctx, {
      run: row,
      mode: opts.mode,
      stages: statuses,
      counters: summaryCounters(row, state.counters),
      holds,
      strict: opts.strict,
      cost_note: opts.costNote?.(row.est_cost_cents) ?? null,
    });
    statuses.push({
      stage: "report",
      status: "done",
      ms: Math.max(0, Math.round(ctx.clock.nowMs() - t0)),
    });
    row = applyStageUpdate(row, { stage: "report", done: true, counters: {}, errors: [], guard });
    await d1.apply(runRowPlan(row));
    if (deps.writeSummary) await deps.writeSummary(rep.output.markdown);
    log.info("run finished", {
      id: row.id,
      failed: rep.output.failed,
      est_cost_cents: row.est_cost_cents,
    });

    return {
      run: row,
      statuses,
      report: rep.output,
      state,
      budgetHits: guard.hits(),
      exitCode: rep.output.failed ? 1 : 0,
    };
  } finally {
    snapshot.close();
  }
}
