import { describe, expect, it } from "vitest";
import { resolveBudget } from "@gof/shared/budget";
import { emptyOverrides } from "../overrides/load.ts";
import { newRunRow } from "../run/accounting.ts";
import { mdCell, report } from "./report.ts";
import type { Context, ReportInput } from "./types.ts";

const ctx: Context = {
  now: new Date("2026-09-28T12:00:00Z"),
  caps: resolveBudget("nightly"),
  overrides: emptyOverrides(),
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  clock: { nowMs: () => 0 },
};

function input(patch: Partial<ReportInput> = {}): ReportInput {
  return {
    run: {
      ...newRunRow("run_1", "nightly", ctx.now),
      fetches: 100,
      est_cost_cents: 163,
      budget_hits: JSON.stringify([
        {
          stage: "discover",
          cap: "MAX_SERP_QUERIES_PER_RUN",
          limit: 5,
          at: "2026-09-28T12:00:00.000Z",
        },
      ]),
      errors: JSON.stringify([
        { stage: "fetch", kind: "network", message: "ECONNRESET | <script>", url: "https://x.org" },
        { stage: "match", kind: "not_implemented", message: "stage not implemented: match" },
      ]),
    },
    mode: "live",
    stages: [
      { stage: "discover", status: "done", ms: 1200 },
      { stage: "match", status: "not_implemented", ms: 0, message: "workstream C" },
    ],
    counters: { fetches: 100, fetch_errors: 20 },
    holds: { sources: { course_unmatched: 3 }, outings: { no_date: 1 } },
    strict: false,
    ...patch,
  };
}

describe("report stage", () => {
  it("summarizes stages, counts, holds by reason, budget hits, errors and cost", () => {
    const { output } = report(ctx, input());
    expect(output.failed).toBe(false);
    expect(output.markdown).toContain("Estimated cost: $1.63.");
    expect(output.markdown).toContain("| discover | done | 1.2 s |");
    expect(output.markdown).toContain("| course_unmatched | 3 | 0 |");
    expect(output.markdown).toContain("| no_date | 0 | 1 |");
    expect(output.markdown).toContain("- `MAX_SERP_QUERIES_PER_RUN` (limit 5) in discover");
    expect(output.markdown).toContain("- fetch (network): ECONNRESET \\| &lt;script&gt; (https://x.org)");
    expect(output.markdown).not.toContain("stage not implemented: match");
  });

  it("fails above 20% fetch errors, not at 20%", () => {
    expect(report(ctx, input()).output.fetchErrorRate).toBe(0.2);
    const over = report(ctx, input({ counters: { fetches: 100, fetch_errors: 21 } })).output;
    expect(over.failed).toBe(true);
    expect(over.failures).toEqual(["21 of 100 fetches failed (21.0%, limit 20%)"]);
  });

  it("fails on a thrown stage, and on a stub only with strict", () => {
    expect(report(ctx, input({ strict: true })).output.failures).toEqual([
      "stage match is not implemented (--strict)",
    ]);
    const thrown = report(
      ctx,
      input({ stages: [{ stage: "fetch", status: "failed", ms: 1, message: "boom" }] }),
    ).output;
    expect(thrown.failures).toEqual(["stage fetch threw: boom"]);
    expect(thrown.markdown).toContain("**Result: FAILED**");
  });

  it("keeps cell text inert", () => {
    expect(mdCell("a|b\n<img src=x onerror=alert(1)>`x`")).toBe(
      "a\\|b &lt;img src=x onerror=alert(1)&gt;'x'",
    );
    expect(mdCell("x".repeat(400))).toHaveLength(300);
  });
});
