import { describe, expect, it } from "vitest";
import { BudgetGuard } from "./budget.ts";
import { runPipeline } from "./run.ts";

describe("runPipeline (Phase 0 skeleton)", () => {
  it("runs all stages by default in dry-run with zero counts and no budget hits", async () => {
    const guard = new BudgetGuard();
    const result = await runPipeline({ mode: "dry-run", budget: "nightly", stages: null, guard });
    expect(result.budgetHits).toEqual([]);
    expect(Object.keys(result.counts)).toContain("discover");
    expect(Object.keys(result.counts)).toContain("report");
  });

  it("respects an explicit stages list", async () => {
    const guard = new BudgetGuard();
    const result = await runPipeline({
      mode: "dry-run",
      budget: "monthly",
      stages: ["discover"],
      guard,
    });
    expect(Object.keys(result.counts)).toEqual(["discover"]);
  });
});
