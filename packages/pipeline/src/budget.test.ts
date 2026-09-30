import { describe, expect, it } from "vitest";
import { BudgetGuard } from "./budget.ts";

describe("BudgetGuard", () => {
  it("consumes up to the cap and refuses beyond it", () => {
    const guard = new BudgetGuard({ MAX_SERP_QUERIES_PER_RUN: "3" });
    expect(guard.tryConsume("MAX_SERP_QUERIES_PER_RUN")).toBe(true);
    expect(guard.tryConsume("MAX_SERP_QUERIES_PER_RUN")).toBe(true);
    expect(guard.tryConsume("MAX_SERP_QUERIES_PER_RUN")).toBe(true);
    expect(guard.tryConsume("MAX_SERP_QUERIES_PER_RUN")).toBe(false);
    expect(guard.hitList()).toContain("MAX_SERP_QUERIES_PER_RUN");
  });

  it("consumes multiple units atomically", () => {
    const guard = new BudgetGuard({ MAX_EXTRACTIONS_PER_RUN: "5" });
    expect(guard.tryConsume("MAX_EXTRACTIONS_PER_RUN", 3)).toBe(true);
    expect(guard.tryConsume("MAX_EXTRACTIONS_PER_RUN", 3)).toBe(false);
    expect(guard.spent("MAX_EXTRACTIONS_PER_RUN")).toBe(3);
  });
});
