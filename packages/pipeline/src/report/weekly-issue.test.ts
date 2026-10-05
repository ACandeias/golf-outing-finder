import { describe, expect, it } from "vitest";
import type { RunRow } from "../stages/rows.ts";
import {
  aggregateWeek,
  decideWeekly,
  renderWeeklyIssue,
  WEEKLY_ISSUE_TITLE,
  weeklyRunsSql,
  type WeeklyIssueInput,
} from "./weekly-issue.ts";

const MONDAY = new Date("2026-09-28T07:20:00.000Z");

function runRow(patch: Partial<RunRow> = {}): RunRow {
  return {
    id: "run_a",
    kind: "nightly",
    started_at: "2026-09-27T07:15:00.000Z",
    finished_at: "2026-09-27T08:40:00.000Z",
    stages_done: "[]",
    serp_queries: 400,
    fetches: 2000,
    renders: 100,
    extractions: 450,
    course_classifications: 0,
    llm_input_tokens: 1_800_000,
    llm_output_tokens: 200_000,
    pending_batch_id: null,
    outings_new: 120,
    outings_updated: 30,
    outings_held: 15,
    budget_hits: "[]",
    errors: "[]",
    est_cost_cents: 250,
    ...patch,
  };
}

describe("decideWeekly", () => {
  const base = {
    mode: "live" as const,
    job: "nightly" as const,
    now: MONDAY,
    force: false,
    d1Target: "remote" as const,
    token: "ghs_secret_token_value",
    repo: "ACandeias/golf_outing",
  };

  it("posts on a Monday (UTC) from the live nightly against the production D1", () => {
    expect(decideWeekly(base)).toEqual({ action: "post", reason: "Monday" });
  });

  it("does not run on other days unless forced", () => {
    const tuesday = new Date("2026-09-29T07:20:00Z");
    expect(decideWeekly({ ...base, now: tuesday }).action).toBe("skip");
    // Sunday 23:59 in New York is already Monday in UTC: the UTC date decides.
    expect(decideWeekly({ ...base, now: new Date("2026-09-28T03:59:00Z") }).action).toBe("post");
    expect(decideWeekly({ ...base, now: tuesday, force: true })).toEqual({ action: "post", reason: "--weekly-report" });
  });

  it("only renders in a dry run, never posts", () => {
    expect(decideWeekly({ ...base, mode: "dry-run", d1Target: "memory" })).toEqual({
      action: "render",
      reason: "dry run: rendered, not posted",
    });
    expect(decideWeekly({ ...base, mode: "dry-run", now: new Date("2026-09-29T07:20:00Z") }).action).toBe("skip");
  });

  it("skips the monthly job, a missing token or repository, and a run on a local D1", () => {
    expect(decideWeekly({ ...base, job: "monthly" }).action).toBe("skip");
    expect(decideWeekly({ ...base, token: undefined })).toEqual({
      action: "skip",
      reason: "GH_TOKEN or GITHUB_REPOSITORY is not set",
    });
    expect(decideWeekly({ ...base, repo: undefined }).action).toBe("skip");
    expect(decideWeekly({ ...base, d1Target: "local" }).action).toBe("skip");
  });
});

describe("weeklyRunsSql", () => {
  it("selects the runs started in the 7 days up to now", () => {
    expect(weeklyRunsSql(MONDAY)).toBe(
      "SELECT * FROM runs WHERE started_at > '2026-09-21T07:20:00.000Z' AND started_at <= '2026-09-28T07:20:00.000Z' ORDER BY started_at, id",
    );
  });
});

describe("aggregateWeek", () => {
  it("sums the counters and cost, counts runs, budget hits and errors by kind", () => {
    const week = aggregateWeek(
      [
        runRow({
          id: "run_1",
          budget_hits: JSON.stringify([
            { stage: "discover", cap: "MAX_SERP_QUERIES_PER_RUN", limit: 450, at: "2026-09-22T07:20:00.000Z" },
          ]),
          errors: JSON.stringify([
            { stage: "fetch", kind: "network", message: "timeout", url: "https://a.example/x" },
            { stage: "fetch", kind: "network", message: "reset" },
            { stage: "discover", kind: "not_implemented", message: "stub" },
          ]),
        }),
        runRow({
          id: "run_2",
          started_at: "2026-09-26T07:15:00.000Z",
          budget_hits: JSON.stringify([
            { stage: "discover", cap: "MAX_SERP_QUERIES_PER_RUN", limit: 450, at: "2026-09-26T07:20:00.000Z" },
            { stage: "extract-request-build", cap: "MAX_LLM_INPUT_TOKENS_PER_RUN", limit: 2000000, at: "2026-09-26T08:00:00.000Z" },
          ]),
          errors: JSON.stringify([{ stage: "fetch", kind: "forced", message: "forced failure (--fail-stage=fetch)" }]),
        }),
        runRow({ id: "run_3", kind: "monthly", finished_at: null, est_cost_cents: 1300, serp_queries: 0 }),
        runRow({ id: "run_4", errors: "not json" }),
      ],
      MONDAY,
    );
    expect(week.runs).toEqual({ total: 4, nightly: 3, monthly: 1, failed: 1, unfinished: 1 });
    expect(week.totals.serp_queries).toBe(1200);
    expect(week.totals.fetches).toBe(8000);
    expect(week.totals.outings_new).toBe(480);
    expect(week.est_cost_cents).toBe(250 * 3 + 1300);
    expect(week.budget_hits).toEqual([
      { cap: "MAX_SERP_QUERIES_PER_RUN", runs: 2 },
      { cap: "MAX_LLM_INPUT_TOKENS_PER_RUN", runs: 1 },
    ]);
    expect(week.errors_by_kind).toEqual({ network: 2, forced: 1 });
    expect(week.failures).toEqual([
      {
        run_id: "run_2",
        started_at: "2026-09-26T07:15:00.000Z",
        stage: "fetch",
        kind: "forced",
        message: "forced failure (--fail-stage=fetch)",
      },
    ]);
    expect(week.from).toBe("2026-09-21T07:20:00.000Z");
    expect(week.to).toBe("2026-09-28T07:20:00.000Z");
  });

  it("is empty for a week with no runs", () => {
    const week = aggregateWeek([], MONDAY);
    expect(week.runs.total).toBe(0);
    expect(week.est_cost_cents).toBe(0);
    expect(week.budget_hits).toEqual([]);
  });
});

describe("renderWeeklyIssue", () => {
  const input: WeeklyIssueInput = {
    week: aggregateWeek(
      [
        runRow({
          errors: JSON.stringify([
            { stage: "publish", kind: "internal", message: "boom <script>alert(1)</script> | x" },
          ]),
        }),
      ],
      MONDAY,
    ),
    holds: { sources: { course_unmatched: 12, low_confidence: 3 }, outings: { removed: 1 } },
    published: { published: 2100, upcoming: 1800, expected: 300, upcoming_states: 31 },
    month: { spent_cents: 4321, cap_cents: 15000 },
    runId: "run_now",
    now: MONDAY,
  };

  it("has the week's counts, holds by reason and the estimated cost", () => {
    const md = renderWeeklyIssue(input);
    expect(md.startsWith(`## ${WEEKLY_ISSUE_TITLE}`)).toBe(true);
    expect(md).toContain("Week of 2026-09-21 to 2026-09-28");
    expect(md).toContain("| Runs | 1 (1 nightly, 0 monthly) |");
    expect(md).toContain("| fetches | 2000 |");
    expect(md).toContain("| outings_new | 120 |");
    expect(md).toContain("2100 published (1800 upcoming in 31 states, 300 expected)");
    expect(md).toContain("### Holds by reason");
    expect(md).toContain("| course_unmatched | 12 | 0 |");
    expect(md).toContain("| removed | 0 | 1 |");
    expect(md).toContain("Estimated cost this week: $2.50.");
    expect(md).toContain("This month so far: $43.21 of the $150.00 cap (MONTHLY_SPEND_CAP_CENTS), 29%.");
    expect(md).toContain("run_now");
  });

  it("keeps error text inert", () => {
    const md = renderWeeklyIssue(input);
    expect(md).not.toContain("<script>");
    expect(md).toContain("&lt;script&gt;");
    expect(md).toContain("\\| x");
  });

  it("stays under GitHub's 65,536-character body limit", () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      runRow({
        id: `run_${i}`,
        errors: JSON.stringify([{ stage: "publish", kind: "internal", message: "x".repeat(300) }]),
      }),
    );
    expect(renderWeeklyIssue({ ...input, week: aggregateWeek(many, MONDAY) }).length).toBeLessThan(65_536);
  });
});
