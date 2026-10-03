import { describe, expect, it } from "vitest";
import { resolveBudget } from "@gof/shared/budget";
import { MemoryD1 } from "../d1/memory.ts";
import { memoryLogger } from "../lib/logger.ts";
import { emptyOverrides } from "../overrides/load.ts";
import { NIGHTLY_STAGES, selectStages, type StageName } from "../stages/registry.ts";
import { runRowSchema } from "../stages/rows.ts";
import { emptyResult, type Context } from "../stages/types.ts";
import { newRunRow, runRowPlan } from "./accounting.ts";
import { defaultHandlers, type StageHandler, type StageHandlers } from "./handlers.ts";
import { runPipeline, type RunOptions } from "./runner.ts";

const NOW = new Date("2026-09-28T12:00:00.000Z");

function ctxWith(
  env: Record<string, string> = {},
): Context & { log: ReturnType<typeof memoryLogger> } {
  let t = 0;
  return {
    now: NOW,
    caps: resolveBudget("nightly", env),
    overrides: emptyOverrides(),
    log: memoryLogger(),
    clock: { nowMs: () => (t += 5) },
  };
}

const done: StageHandler = async () => ({ result: emptyResult() });
function allDone(patch: Partial<StageHandlers> = {}): StageHandlers {
  const h = Object.fromEntries(Object.keys(defaultHandlers).map((k) => [k, done])) as StageHandlers;
  return { ...h, ...patch };
}

const nightly: RunOptions = {
  mode: "dry-run",
  job: "nightly",
  stages: selectStages(undefined, "nightly"),
  failStage: null,
  strict: false,
};

async function run(
  opts: Partial<RunOptions> = {},
  handlers: StageHandlers = defaultHandlers,
  env = {},
  d1 = new MemoryD1(),
) {
  const summaries: string[] = [];
  const outcome = await runPipeline(
    { ...nightly, ...opts },
    {
      ctx: ctxWith(env),
      d1,
      handlers,
      runId: "run_test",
      writeSummary: async (md) => summaries.push(md),
    },
  );
  const rows = d1.db
    .prepare("SELECT * FROM runs WHERE id = 'run_test'")
    .all()
    .map((r) => runRowSchema.parse({ ...r }));
  return { outcome, d1, rows, summaries };
}

function runWrites(d1: MemoryD1): number {
  return d1.applied.flat().filter((s) => s.startsWith("INSERT INTO runs")).length;
}

describe("runPipeline with the Phase 2A stubs", () => {
  it("reports every unimplemented stage by name and exits 0 without --strict", async () => {
    const { outcome, rows, d1, summaries } = await run();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.statuses.map((s) => [s.stage, s.status])).toEqual([
      ...NIGHTLY_STAGES.filter((s) => s !== "report").map((s) => [s, "not_implemented"]),
      ["report", "done"],
    ]);
    expect(outcome.statuses.find((s) => s.stage === "classify")?.message).toBe("workstream C");
    // Written at start, after each of the 10 stages, and after the report.
    expect(runWrites(d1)).toBe(12);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.finished_at).not.toBeNull();
    expect(JSON.parse(row.stages_done)).toEqual(["report"]);
    expect(JSON.parse(row.errors).map((e: { stage: string }) => e.stage)).toContain(
      "recheck-roll-forward",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("| match | not implemented (workstream C) |");
    expect(summaries[0]).toContain("**Result: OK**");
  });

  it("fails on the first stub with --strict and skips the rest", async () => {
    const { outcome } = await run({ strict: true });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.statuses[0]).toMatchObject({ stage: "discover", status: "not_implemented" });
    expect(outcome.statuses[1]).toMatchObject({ stage: "fetch", status: "skipped" });
    expect(outcome.report.failures).toEqual(["stage discover is not implemented (--strict)"]);
  });

  it("runs the monthly stages", async () => {
    const { outcome, rows } = await run({
      job: "monthly",
      stages: selectStages("courses,irs,course-types", "monthly"),
    });
    expect(outcome.statuses.map((s) => s.stage)).toEqual([
      "courses",
      "irs",
      "course-types",
      "report",
    ]);
    expect(rows[0]?.kind).toBe("monthly");
  });
});

describe("runPipeline failure rules", () => {
  it("--fail-stage throws inside that stage, skips later stages, still reports, exits 1", async () => {
    const { outcome, rows, summaries } = await run({ failStage: "match" }, allDone());
    expect(outcome.exitCode).toBe(1);
    const byStage = Object.fromEntries(outcome.statuses.map((s) => [s.stage, s.status]));
    expect(byStage).toMatchObject({
      classify: "done",
      match: "failed",
      "dedupe-upsert": "skipped",
      report: "done",
    });
    const errors = JSON.parse(rows[0]!.errors) as { kind: string; stage: string }[];
    expect(errors).toEqual([
      { stage: "match", kind: "forced", message: "forced failure (--fail-stage=match)" },
    ]);
    expect(summaries[0]).toMatch(/\*\*Result: FAILED\*\*: stage match threw: forced failure/);
  });

  it("a stage that throws fails the run", async () => {
    const boom: StageHandler = async () => {
      throw new Error("unexpected <b>input</b>");
    };
    const { outcome, summaries } = await run({}, allDone({ normalize: boom }));
    expect(outcome.exitCode).toBe(1);
    expect(summaries[0]).toContain("unexpected &lt;b&gt;input&lt;/b&gt;");
  });

  it("fails when more than 20% of fetches error (network and 5xx only)", async () => {
    const fetchWith =
      (errors: number): StageHandler =>
      async ({ guard }) => {
        for (let i = 0; i < 10; i++) guard.check("MAX_FETCHES_PER_RUN", 1, "fetch");
        return {
          result: { ...emptyResult(), counters: { fetch_errors: errors, fetch_not_found: 4 } },
        };
      };
    expect((await run({}, allDone({ fetch: fetchWith(2) }))).outcome.exitCode).toBe(0);
    const bad = await run({}, allDone({ fetch: fetchWith(3) }));
    expect(bad.outcome.exitCode).toBe(1);
    expect(bad.outcome.report.fetchErrorRate).toBeCloseTo(0.3);
    expect(bad.outcome.report.failures[0]).toMatch(/3 of 10 fetches failed/);
    expect(bad.rows[0]?.fetches).toBe(10);
  });
});

describe("runPipeline budgets", () => {
  it("MAX_SERP_QUERIES_PER_RUN=5 stops search calls at 5 and every other stage completes", async () => {
    let attempted = 0;
    let made = 0;
    const discover: StageHandler = async ({ guard }) => {
      for (let i = 0; i < 40; i++) {
        attempted++;
        if (guard.check("MAX_SERP_QUERIES_PER_RUN", 1, "discover")) made++;
      }
      return { result: emptyResult() };
    };
    const { outcome, rows } = await run({}, allDone({ discover }), {
      MAX_SERP_QUERIES_PER_RUN: "5",
    });
    expect(attempted).toBe(40);
    expect(made).toBe(5);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.statuses.every((s) => s.status === "done")).toBe(true);
    const row = rows[0]!;
    expect(row.serp_queries).toBe(5);
    expect(row.est_cost_cents).toBe(1); // 5 x $0.0006, rounded up
    expect(JSON.parse(row.budget_hits)).toEqual([
      { stage: "discover", cap: "MAX_SERP_QUERIES_PER_RUN", limit: 5, at: NOW.toISOString() },
    ]);
    expect(JSON.parse(row.stages_done)).toEqual([...NIGHTLY_STAGES]);
  });

  it("at the monthly spend cap, paid work is skipped with a budget hit and the run completes", async () => {
    const d1 = new MemoryD1();
    const earlier = {
      ...newRunRow("run_earlier", "nightly", new Date("2026-09-02T07:15:00.000Z")),
      est_cost_cents: 15_000,
    };
    await d1.apply(runRowPlan(earlier));
    let serpAllowed: boolean | null = null;
    const discover: StageHandler = async ({ guard }) => {
      serpAllowed = guard.check("MAX_SERP_QUERIES_PER_RUN", 1, "discover");
      return { result: emptyResult() };
    };
    const { outcome } = await run({}, allDone({ discover }), {}, d1);
    expect(serpAllowed).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.budgetHits[0]).toMatchObject({
      cap: "MONTHLY_SPEND_CAP_CENTS",
      stage: "discover",
    });
    expect(outcome.statuses.every((s) => s.status === "done")).toBe(true);
  });

  it("ignores last month's spend", async () => {
    const d1 = new MemoryD1();
    await d1.apply(
      runRowPlan({
        ...newRunRow("run_aug", "nightly", new Date("2026-08-31T07:15:00.000Z")),
        est_cost_cents: 99_000,
      }),
    );
    const { outcome } = await run({}, allDone(), {}, d1);
    expect(outcome.budgetHits).toEqual([]);
  });
});

describe("runPipeline writes", () => {
  it("applies a stage's plan and records the pending batch id", async () => {
    const extract: StageHandler = async () => ({
      result: emptyResult(),
      pendingBatchId: "msgbatch_013Zva",
    });
    const recheck: StageHandler = async () => ({
      result: { ...emptyResult(), counters: { outings_held: 2 } },
      plan: {
        ops: [
          {
            op: "upsert",
            table: "discovery_queue",
            rows: [
              {
                url: "https://example.org/golf",
                found_via: "recheck",
                found_at: NOW.toISOString(),
                priority: 1,
                next_attempt_at: null,
                attempts: 0,
              },
            ],
          },
        ],
      },
    });
    const { rows, d1 } = await run(
      {},
      allDone({ "extract-collect": extract, "recheck-roll-forward": recheck }),
    );
    expect(rows[0]?.pending_batch_id).toBe("msgbatch_013Zva");
    expect(rows[0]?.outings_held).toBe(2);
    expect(d1.db.prepare("SELECT url FROM discovery_queue").all()).toEqual([
      { url: "https://example.org/golf" },
    ]);
  });

  it("rejects a malformed StageResult as a stage failure", async () => {
    const bad: StageHandler = async () => ({
      result: {
        ...emptyResult(),
        counters: { not_a_counter: 1 } as unknown as Record<string, number>,
      },
    });
    const { outcome } = await run({}, allDone({ classify: bad }));
    expect(outcome.statuses.find((s) => s.stage === "classify")?.status).toBe("failed");
  });

  it("selected stages run in order with report last", async () => {
    const seen: StageName[] = [];
    const track: StageHandler = async ({ stage }) => {
      seen.push(stage);
      return { result: emptyResult() };
    };
    const handlers = allDone(
      Object.fromEntries(Object.keys(defaultHandlers).map((k) => [k, track])),
    );
    const { outcome } = await run({ stages: selectStages("match,classify", "nightly") }, handlers);
    expect(seen).toEqual(["classify", "match"]);
    expect(outcome.statuses.map((s) => s.stage)).toEqual(["classify", "match", "report"]);
  });
});
