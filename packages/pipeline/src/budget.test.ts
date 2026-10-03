import { describe, expect, it } from "vitest";
import { BUDGET_PROFILES } from "@gof/shared/budget";
import { BudgetGuard, estimateCostCents, monthSpentCents, METERS, PAID_METERS } from "./budget.ts";

const NOW = new Date("2026-09-28T12:00:00Z");

function fakeClock(start = 0): { nowMs: () => number; advance: (ms: number) => void } {
  let t = start;
  return { nowMs: () => t, advance: (ms) => (t += ms) };
}

describe("BudgetGuard caps", () => {
  it("resolves the nightly and monthly profiles from SPEC 14", () => {
    expect(new BudgetGuard({ profile: "nightly" }).caps).toEqual(BUDGET_PROFILES.nightly);
    expect(new BudgetGuard({ profile: "monthly" }).caps).toEqual(BUDGET_PROFILES.monthly);
    expect(
      new BudgetGuard({ profile: "nightly", env: { MAX_FETCHES_PER_RUN: "10" } }).caps
        .MAX_FETCHES_PER_RUN,
    ).toBe(10);
  });

  it.each(METERS)("%s: consumes up to the cap, then records one hit and returns false", (meter) => {
    const guard = new BudgetGuard({ profile: "nightly", env: { [meter]: "3" }, now: NOW });
    expect([1, 2, 3].map(() => guard.check(meter, 1, "s"))).toEqual([true, true, true]);
    expect(guard.check(meter, 1, "s")).toBe(false);
    expect(guard.check(meter, 1, "s")).toBe(false);
    expect(guard.spent(meter)).toBe(3);
    expect(guard.hits()).toEqual([{ stage: "s", cap: meter, limit: 3, at: NOW.toISOString() }]);
  });

  it("consumes multiple units atomically", () => {
    const guard = new BudgetGuard("nightly", { MAX_LLM_INPUT_TOKENS_PER_RUN: "5000" });
    expect(guard.check("MAX_LLM_INPUT_TOKENS_PER_RUN", 4000)).toBe(true);
    expect(guard.check("MAX_LLM_INPUT_TOKENS_PER_RUN", 4000)).toBe(false);
    expect(guard.spent("MAX_LLM_INPUT_TOKENS_PER_RUN")).toBe(4000);
    expect(guard.remaining("MAX_LLM_INPUT_TOKENS_PER_RUN")).toBe(1000);
  });

  it("monthly profile allows no SERP queries, extractions or renders", () => {
    const guard = new BudgetGuard("monthly");
    expect(guard.check("MAX_SERP_QUERIES_PER_RUN")).toBe(false);
    expect(guard.check("MAX_EXTRACTIONS_PER_RUN")).toBe(false);
    expect(guard.check("MAX_RENDERS_PER_RUN")).toBe(false);
    expect(guard.remaining("MAX_COURSE_CLASSIFICATIONS_PER_RUN")).toBe(4000);
    expect(guard.remaining("MAX_FETCHES_PER_RUN")).toBe(8000);
  });

  it("nightly profile allows no course classifications", () => {
    expect(new BudgetGuard("nightly").check("MAX_COURSE_CLASSIFICATIONS_PER_RUN")).toBe(false);
  });

  it("MAX_SERP_QUERIES_PER_RUN=5 stops search calls at 5", () => {
    const guard = new BudgetGuard({
      profile: "nightly",
      env: { MAX_SERP_QUERIES_PER_RUN: "5" },
      now: NOW,
    });
    let made = 0;
    for (let i = 0; i < 450; i++)
      if (guard.check("MAX_SERP_QUERIES_PER_RUN", 1, "discover")) made++;
    expect(made).toBe(5);
    expect(guard.hits()).toHaveLength(1);
    expect(guard.hits()[0]).toMatchObject({
      cap: "MAX_SERP_QUERIES_PER_RUN",
      limit: 5,
      stage: "discover",
    });
    // Other caps are untouched.
    expect(guard.check("MAX_FETCHES_PER_RUN", 1, "fetch")).toBe(true);
  });

  it("MAX_FETCHES_PER_HOST_PER_RUN counts per host, case-insensitively", () => {
    const guard = new BudgetGuard({
      profile: "nightly",
      env: { MAX_FETCHES_PER_HOST_PER_RUN: "2" },
    });
    expect(guard.checkHost("Example.org")).toBe(true);
    expect(guard.checkHost("example.org")).toBe(true);
    expect(guard.checkHost("example.org")).toBe(false);
    expect(guard.checkHost("other.org")).toBe(true);
    expect(guard.hits()[0]).toMatchObject({
      cap: "MAX_FETCHES_PER_HOST_PER_RUN",
      detail: "example.org",
    });
    expect(() => guard.check("MAX_FETCHES_PER_HOST_PER_RUN")).toThrow(/checkHost/);
  });

  it("MAX_FETCH_MINUTES stops the fetch stage after 45 minutes", () => {
    const clock = fakeClock(1_000);
    const guard = new BudgetGuard({ profile: "nightly", clock });
    guard.startFetchTimer();
    clock.advance(44 * 60_000);
    expect(guard.check("MAX_FETCH_MINUTES", 1, "fetch")).toBe(true);
    clock.advance(60_000);
    expect(guard.check("MAX_FETCH_MINUTES", 1, "fetch")).toBe(false);
    expect(guard.hits()[0]).toMatchObject({ cap: "MAX_FETCH_MINUTES", limit: 45 });
  });

  it("records usage reported in stage counters", () => {
    const guard = new BudgetGuard({ profile: "nightly", env: { MAX_EXTRACTIONS_PER_RUN: "10" } });
    guard.record({
      extractions: 7,
      llm_input_tokens: 28_000,
      llm_output_tokens: 3_500,
      fetches: 9,
    });
    expect(guard.remaining("MAX_EXTRACTIONS_PER_RUN")).toBe(3);
    expect(guard.spent("MAX_FETCHES_PER_RUN")).toBe(9);
    expect(guard.allowance()).toMatchObject({
      MAX_EXTRACTIONS_PER_RUN: 3,
      MAX_FETCHES_PER_RUN: 2491,
    });
  });

  it("dedupes hits per cap and stage, and merges stage-reported hits", () => {
    const guard = new BudgetGuard({ profile: "nightly", now: NOW });
    guard.recordHit("MAX_RENDERS_PER_RUN", "fetch");
    guard.addHits([
      { stage: "fetch", cap: "MAX_RENDERS_PER_RUN", limit: 400, at: NOW.toISOString() },
      {
        stage: "extract-request-build",
        cap: "MAX_LLM_INPUT_TOKENS_PER_RUN",
        limit: 2_000_000,
        at: NOW.toISOString(),
      },
    ]);
    expect(guard.hits().map((h) => h.cap)).toEqual([
      "MAX_RENDERS_PER_RUN",
      "MAX_LLM_INPUT_TOKENS_PER_RUN",
    ]);
  });
});

describe("cost estimation (SPEC 14 rates)", () => {
  it("prices Haiku batch tokens and DataForSEO queries", () => {
    expect(
      estimateCostCents({ llm_input_tokens: 2_000_000, llm_output_tokens: 0, serp_queries: 0 }),
    ).toBe(100);
    expect(
      estimateCostCents({ llm_input_tokens: 0, llm_output_tokens: 1_000_000, serp_queries: 0 }),
    ).toBe(250);
    expect(
      estimateCostCents({ llm_input_tokens: 0, llm_output_tokens: 0, serp_queries: 1_000 }),
    ).toBe(60);
    expect(
      estimateCostCents({ llm_input_tokens: 0, llm_output_tokens: 0, serp_queries: 450 }),
    ).toBe(27);
  });

  it("estimates a full nightly run of 500 extractions at about $1.63, rounding up", () => {
    // 500 pages x (4,000 in + 500 out) = $1.00 + $0.625; plus 450 queries = $0.27.
    expect(
      estimateCostCents({
        llm_input_tokens: 2_000_000,
        llm_output_tokens: 250_000,
        serp_queries: 0,
      }),
    ).toBe(163);
    expect(
      estimateCostCents({
        llm_input_tokens: 2_000_000,
        llm_output_tokens: 250_000,
        serp_queries: 450,
      }),
    ).toBe(190);
    expect(estimateCostCents({ llm_input_tokens: 1, llm_output_tokens: 0, serp_queries: 0 })).toBe(
      1,
    );
    expect(estimateCostCents({ llm_input_tokens: 0, llm_output_tokens: 0, serp_queries: 0 })).toBe(
      0,
    );
  });

  it("tracks the run's estimate from what the guard consumed", () => {
    const guard = new BudgetGuard({ profile: "nightly" });
    guard.check("MAX_LLM_INPUT_TOKENS_PER_RUN", 1_000_000);
    guard.recordOutputTokens(200_000);
    for (let i = 0; i < 100; i++) guard.check("MAX_SERP_QUERIES_PER_RUN");
    expect(guard.estCostCents()).toBe(50 + 50 + 6);
  });
});

describe("MONTHLY_SPEND_CAP_CENTS", () => {
  const runs = [
    { id: "run_a", started_at: "2026-09-01T07:15:00.000Z", est_cost_cents: 9_000 },
    { id: "run_b", started_at: "2026-09-27T07:15:00.000Z", est_cost_cents: 5_000 },
    { id: "run_old", started_at: "2026-08-31T07:15:00.000Z", est_cost_cents: 50_000 },
    { id: "run_now", started_at: "2026-09-28T07:15:00.000Z", est_cost_cents: 99_999 },
  ];

  it("sums this calendar month's runs, excluding the current run", () => {
    expect(monthSpentCents(runs, NOW, "run_now")).toBe(14_000);
    expect(monthSpentCents(runs, new Date("2026-08-15T00:00:00Z"))).toBe(50_000);
  });

  it("allows paid work under the cap", () => {
    const guard = new BudgetGuard({
      profile: "nightly",
      now: NOW,
      monthRuns: runs,
      runId: "run_now",
    });
    expect(guard.monthlySpendOk("discover")).toBe(true);
    expect(guard.allowance().MONTHLY_SPEND_CAP_CENTS).toBe(1_000);
  });

  it("at the cap, skips paid work, records a hit, and leaves free work alone", () => {
    const guard = new BudgetGuard({
      profile: "nightly",
      env: { MONTHLY_SPEND_CAP_CENTS: "14000" },
      now: NOW,
      monthRuns: runs,
      runId: "run_now",
    });
    expect(guard.monthlySpendOk("discover")).toBe(false);
    expect(guard.paidWorkBlocked).toBe(true);
    for (const m of PAID_METERS) {
      expect(guard.check(m, 1, "extract-request-build")).toBe(false);
      expect(guard.allowance()[m]).toBe(0);
    }
    expect(guard.check("MAX_FETCHES_PER_RUN", 1, "fetch")).toBe(true);
    expect(guard.hits().every((h) => h.cap === "MONTHLY_SPEND_CAP_CENTS")).toBe(true);
    expect(guard.hits()[0]).toMatchObject({ stage: "discover", limit: 14_000 });
  });

  it("counts this run's own spend toward the cap", () => {
    const guard = new BudgetGuard({
      profile: "nightly",
      env: { MONTHLY_SPEND_CAP_CENTS: "14050" },
      now: NOW,
      monthRuns: runs,
      runId: "run_now",
    });
    expect(guard.monthlySpendOk("discover")).toBe(true);
    guard.check("MAX_LLM_INPUT_TOKENS_PER_RUN", 2_000_000, "extract-request-build"); // 100 cents
    expect(guard.monthlySpendOk("extract-collect")).toBe(false);
    expect(guard.check("MONTHLY_SPEND_CAP_CENTS", 1, "course-types")).toBe(false);
  });
});
