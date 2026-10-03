import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveBudget } from "@gof/shared/budget";
import { MemoryD1 } from "../d1/memory.ts";
import { memoryLogger } from "../lib/logger.ts";
import { PATHS } from "../lib/paths.ts";
import { loadOverrides, type Overrides } from "../overrides/load.ts";
import { newRunRow, runRowPlan } from "../run/accounting.ts";
import { stubHandlers, type StageHandlers } from "../run/handlers.ts";
import { runPipeline, type RunOutcome } from "../run/runner.ts";
import type { StageName } from "../stages/registry.ts";
import { runRowSchema, type RunRow } from "../stages/rows.ts";
import type { BatchClient, Context, PageFetcher } from "../stages/types.ts";
import { courseTypesHandler, type CourseTypesHandlerDeps } from "./course-types-handler.ts";
import { fixtureBatchClient, fixturePageFetcher } from "./course-types-ports.ts";
import { coursesHandler } from "./monthly.ts";

let overrides: Overrides | null = null;
async function ctx(now: string, env: Record<string, string> = {}): Promise<Context> {
  overrides ??= await loadOverrides({ overrides: PATHS.overrides, places: PATHS.places });
  let t = 0;
  return {
    now: new Date(now),
    caps: resolveBudget("monthly", env),
    overrides,
    log: memoryLogger(),
    clock: { nowMs: () => (t += 1) },
  };
}

async function run(
  d1: MemoryD1,
  deps: CourseTypesHandlerDeps,
  o: {
    runId?: string;
    now?: string;
    env?: Record<string, string>;
    stages?: StageName[];
    mode?: "dry-run" | "live";
  } = {},
): Promise<{ outcome: RunOutcome; row: RunRow }> {
  const runId = o.runId ?? "run_ct";
  const handlers: StageHandlers = {
    ...stubHandlers(),
    courses: coursesHandler(),
    "course-types": courseTypesHandler({ sleep: async () => {}, ...deps }),
  };
  const outcome = await runPipeline(
    {
      mode: o.mode ?? "dry-run",
      job: "monthly",
      stages: o.stages ?? ["courses", "course-types", "report"],
      failStage: null,
      strict: true,
    },
    { ctx: await ctx(o.now ?? "2026-10-01T10:30:00.000Z", o.env), d1, handlers, runId },
  );
  const row = runRowSchema.parse({
    ...d1.db.prepare(`SELECT * FROM runs WHERE id = '${runId}'`).get(),
  });
  return { outcome, row };
}

const typed = z.object({
  osm_ref: z.string(),
  course_type: z.string(),
  course_type_source: z.string().nullable(),
  course_type_confidence: z.number().nullable(),
});
function typeOf(d1: MemoryD1, osmRef: string) {
  return typed.parse({
    ...d1.db
      .prepare(
        `SELECT osm_ref, course_type, course_type_source, course_type_confidence FROM courses WHERE osm_ref = '${osmRef}'`,
      )
      .get(),
  });
}

describe("course-types handler (SPEC.md 8.1 step 4.3)", () => {
  it("classifies fixture courses in a dry run and accepts only confidence 0.7 or higher", async () => {
    const d1 = new MemoryD1();
    const batch = await fixtureBatchClient();
    const { outcome, row } = await run(d1, { batch });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.statuses.map((s) => [s.stage, s.status])).toEqual([
      ["courses", "done"],
      ["course-types", "done"],
      ["report", "done"],
    ]);
    expect(typeOf(d1, "way/35679009")).toEqual({
      osm_ref: "way/35679009",
      course_type: "municipal",
      course_type_source: "website_llm",
      course_type_confidence: 0.96,
    });
    expect(typeOf(d1, "way/30432711")).toMatchObject({ course_type: "municipal" });
    expect(typeOf(d1, "way/138263843")).toMatchObject({
      course_type: "private",
      course_type_source: "website_llm",
    });
    // 0.55 stays unknown.
    expect(typeOf(d1, "way/196873161")).toMatchObject({
      course_type: "unknown",
      course_type_source: null,
    });
    // Seeded overrides are untouched.
    expect(typeOf(d1, "way/35679036")).toMatchObject({
      course_type: "municipal",
      course_type_source: "override",
    });
    // Only courses with fetched pages were sent; each request has one or two pages.
    expect(batch.submitted).toHaveLength(1);
    expect(batch.submitted[0]!.map((r) => r.custom_id).sort()).toEqual([
      "way-138263843",
      "way-196873161",
      "way-30432711",
      "way-35679009",
    ]);
    expect(row.course_classifications).toBe(4);
    expect(row.llm_input_tokens).toBeGreaterThan(0);
    expect(row.llm_output_tokens).toBe(4 * 38);
    expect(row.est_cost_cents).toBeGreaterThan(0);
    expect(row.pending_batch_id).toBeNull();
  });

  it("sends courses with outings first and stops at MAX_COURSE_CLASSIFICATIONS_PER_RUN", async () => {
    const d1 = new MemoryD1();
    await run(
      d1,
      { batch: await fixtureBatchClient() },
      { stages: ["courses", "report"], runId: "run_import" },
    );
    d1.db.exec("UPDATE courses SET outing_count = 3 WHERE osm_ref = 'way/196873161'");
    const batch = await fixtureBatchClient();
    const { row, outcome } = await run(
      d1,
      { batch },
      { stages: ["course-types", "report"], env: { MAX_COURSE_CLASSIFICATIONS_PER_RUN: "1" } },
    );
    expect(batch.submitted[0]!.map((r) => r.custom_id)).toEqual(["way-196873161"]);
    expect(row.course_classifications).toBe(1);
    expect(outcome.exitCode).toBe(0);
  });

  it("leaves a running batch pending and collects it on the next monthly run", async () => {
    const d1 = new MemoryD1();
    const inner = await fixtureBatchClient();
    let ended = false;
    const slow: BatchClient = {
      submit: async (reqs) => ({ ...(await inner.submit(reqs)), status: "in_progress" }),
      poll: async (id) => ({ batch_id: id, status: ended ? "ended" : "in_progress" }),
      results: (id) => inner.results(id),
    };
    const first = await run(d1, { batch: slow, pollTimeoutMs: 3 * 60_000 }, { runId: "run_a" });
    expect(first.row.pending_batch_id).toBe("msgbatch_fixture_1");
    expect(typeOf(d1, "way/35679009").course_type).toBe("unknown");

    ended = true;
    const second = await run(
      d1,
      { batch: slow },
      { runId: "run_b", now: "2026-10-02T10:30:00.000Z", stages: ["course-types", "report"] },
    );
    expect(typeOf(d1, "way/35679009").course_type).toBe("municipal");
    const firstRow = runRowSchema.parse({
      ...d1.db.prepare("SELECT * FROM runs WHERE id = 'run_a'").get(),
    });
    expect(firstRow.pending_batch_id).toBeNull();
    expect(second.row.pending_batch_id).toBeNull();
  });

  it("submits nothing once the monthly spend cap is reached", async () => {
    const d1 = new MemoryD1();
    await d1.apply(
      runRowPlan({
        ...newRunRow("run_spent", "nightly", new Date("2026-10-01T07:15:00.000Z")),
        est_cost_cents: 15_000,
      }),
    );
    const batch = await fixtureBatchClient();
    const { outcome } = await run(d1, { batch });
    expect(batch.submitted).toHaveLength(0);
    expect(outcome.budgetHits).toMatchObject([
      { cap: "MONTHLY_SPEND_CAP_CENTS", stage: "course-types" },
    ]);
  });

  it("records an error instead of fetching when a live run has no PageFetcher", async () => {
    const d1 = new MemoryD1();
    await run(d1, {}, { stages: ["courses", "report"], runId: "run_import" });
    const batch = await fixtureBatchClient();
    const { row } = await run(d1, { batch }, { mode: "live", stages: ["course-types", "report"] });
    expect(batch.submitted).toHaveLength(0);
    expect(JSON.parse(row.errors)).toMatchObject([{ stage: "course-types", kind: "internal" }]);
  });

  it("uses an injected PageFetcher and meters fetches", async () => {
    const d1 = new MemoryD1();
    await run(d1, {}, { stages: ["courses", "report"], runId: "run_import" });
    const inner = await fixturePageFetcher(() => "2026-10-01T10:30:00.000Z");
    const urls: string[] = [];
    const fetcher: PageFetcher = {
      fetchPage: async (item, budget) => (urls.push(item.url), inner.fetchPage(item, budget)),
    };
    const { row } = await run(
      d1,
      { fetcher, batch: await fixtureBatchClient() },
      { stages: ["course-types", "report"] },
    );
    expect(urls).toContain("https://www.torreypines.com/about-torrey-pines/");
    expect(row.fetches).toBe(urls.length);
  });
});
