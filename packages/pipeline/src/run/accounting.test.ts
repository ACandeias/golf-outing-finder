import { describe, expect, it } from "vitest";
import { BudgetGuard } from "../budget.ts";
import {
  applyStageUpdate,
  finishRunRow,
  MAX_STORED_ERRORS,
  newRunId,
  newRunRow,
  summaryCounters,
} from "./accounting.ts";

const NOW = new Date("2026-09-28T12:00:00.000Z");

describe("runs row accounting", () => {
  it("makes run ids from the clock", () => {
    expect(newRunId(NOW.getTime(), new Uint8Array(10))).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("takes metered columns from the guard and sums outing counters", () => {
    const guard = new BudgetGuard({ profile: "nightly", now: NOW });
    guard.check("MAX_SERP_QUERIES_PER_RUN", 10);
    guard.check("MAX_LLM_INPUT_TOKENS_PER_RUN", 400_000);
    guard.recordOutputTokens(50_000);
    let row = newRunRow("run_1", "nightly", NOW);
    row = applyStageUpdate(row, {
      stage: "discover",
      done: true,
      counters: { outings_new: 2 },
      errors: [],
      guard,
    });
    row = applyStageUpdate(row, {
      stage: "publish",
      done: true,
      counters: { outings_new: 1, outings_held: 4, fetches: 999 },
      errors: [{ stage: "publish", kind: "validation", message: "x" }],
      guard,
      pendingBatchId: "msgbatch_1",
    });
    expect(row).toMatchObject({
      stages_done: '["discover","publish"]',
      serp_queries: 10,
      llm_input_tokens: 400_000,
      llm_output_tokens: 50_000,
      fetches: 0,
      outings_new: 3,
      outings_held: 4,
      est_cost_cents: 20 + 13 + 1,
      pending_batch_id: "msgbatch_1",
    });
    expect(JSON.parse(row.errors)).toHaveLength(1);
    const again = applyStageUpdate(row, {
      stage: "discover",
      done: true,
      counters: {},
      errors: [],
      guard,
      pendingBatchId: null,
    });
    expect(again.stages_done).toBe('["discover","publish"]');
    expect(again.pending_batch_id).toBeNull();
    expect(finishRunRow(again, NOW).finished_at).toBe(NOW.toISOString());
    expect(summaryCounters(again, { fetch_errors: 2 })).toMatchObject({
      fetch_errors: 2,
      serp_queries: 10,
    });
  });

  it("keeps the last 200 errors", () => {
    const guard = new BudgetGuard({ profile: "nightly" });
    const errors = Array.from({ length: 250 }, (_, i) => ({
      stage: "fetch",
      kind: "network" as const,
      message: `e${i}`,
    }));
    const row = applyStageUpdate(newRunRow("run_1", "nightly", NOW), {
      stage: "fetch",
      done: true,
      counters: {},
      errors,
      guard,
    });
    const stored = JSON.parse(row.errors) as { message: string }[];
    expect(stored).toHaveLength(MAX_STORED_ERRORS);
    expect(stored[0]?.message).toBe("e50");
  });
});
